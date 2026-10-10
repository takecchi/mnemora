import type {
  AbortOptions,
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  LLMResponse,
  PromptSpec,
  StructuredRequest,
} from "@mnemora/core";
import type { Cassette, EmbeddingCassetteEntry, LLMCassetteEntry } from "./cassette.js";
import { CASSETTE_FORMAT_VERSION, embeddingCassetteKey, llmCassetteKey } from "./cassette.js";

/**
 * 実 provider を包んで入出力を記録するデコレータ一式（ADR 0051）。1回の実行で1つのカセットを作る
 * （LLM と埋め込みを別ファイルにすると、片方だけ録り直したときに `recordedAt` と中身が食い違う）。
 * デコレータは委譲先の戻り値を加工せず返す。
 */
export class CassetteRecorder {
  private readonly embeddingEntries = new Map<string, EmbeddingCassetteEntry>();
  private readonly llmEntries = new Map<string, LLMCassetteEntry>();
  private embeddingSpace: EmbeddingSpaceId | undefined;
  private llmModel: string | undefined;

  /** 埋め込みの1件を記録する。同じ `text` を二度記録すると、後の値で上書きする。埋め込み空間が最初と違えば落とす（別モデルのベクトルが1枚に混ざるのを防ぐ）。 */
  recordEmbedding(space: EmbeddingSpaceId, text: string, vector: number[]): void {
    const first = this.embeddingSpace;
    if (
      first !== undefined &&
      (first.provider !== space.provider ||
        first.model !== space.model ||
        first.dimensions !== space.dimensions)
    ) {
      throw new Error(
        "CassetteRecorder: 1枚のカセットに、違う埋め込み空間は記録できない。" +
          `最初: ${first.provider}/${first.model}/${first.dimensions}次元、` +
          `今回: ${space.provider}/${space.model}/${space.dimensions}次元。` +
          "別のカセットに分けること。",
      );
    }
    this.embeddingSpace = { ...space };
    this.embeddingEntries.set(embeddingCassetteKey(text), { text, vector });
  }

  /** LLM の応答の1件を記録する。同じ `prompt` を二度記録すると、後の値で上書きする。モデル名が最初と違えば落とす。 */
  recordLLM(model: string, prompt: PromptSpec, value: unknown): void {
    if (this.llmModel !== undefined && this.llmModel !== model) {
      throw new Error(
        "CassetteRecorder: 1枚のカセットに、違うモデルの LLM 応答は記録できない。" +
          `最初: ${this.llmModel}、今回: ${model}。別のカセットに分けること。`,
      );
    }
    this.llmModel = model;
    this.llmEntries.set(llmCassetteKey(prompt), { prompt, value });
  }

  /** 記録した埋め込みの件数。 */
  get embeddingCount(): number {
    return this.embeddingEntries.size;
  }

  /** 記録した LLM の応答の件数。 */
  get llmCount(): number {
    return this.llmEntries.size;
  }

  /** 既に記録済みの応答を引く。再生用の口ではない（再生は `RecordedLLMProvider`）。 */
  lookupLLM(prompt: PromptSpec): { prompt: PromptSpec; value: unknown } | undefined {
    return this.llmEntries.get(llmCassetteKey(prompt));
  }

  lookupEmbedding(text: string): EmbeddingCassetteEntry | undefined {
    return this.embeddingEntries.get(embeddingCassetteKey(text));
  }

  /** 記録をカセットに固める。一度も記録が無い節があれば落とす（録れていないカセットが、再生時の「記録に無い」まで気づかれない）。 */
  toCassette(now: Date = new Date()): Cassette {
    // 失敗の原因を例外本文に載せる: `observe()` は `externalId` で重複排除するため、取り込み済みのテナントでは抽出も埋め込みも呼ばれない。
    const hint =
      "記録の実行が API を1回も呼んでいない。よくある原因: 取り込み済みのテナントで " +
      "`record` を走らせた——`observe()` は externalId で重複排除するため、抽出も埋め込みも " +
      "呼ばれない。新しい tenantId で録り直すこと（ADR 0051）。";
    if (this.embeddingSpace === undefined || this.embeddingEntries.size === 0) {
      throw new Error(`CassetteRecorder: 埋め込みが1件も記録されていない。${hint}`);
    }
    if (this.llmModel === undefined || this.llmEntries.size === 0) {
      throw new Error(`CassetteRecorder: LLM 応答が1件も記録されていない。${hint}`);
    }
    return {
      version: CASSETTE_FORMAT_VERSION,
      recordedAt: now.toISOString(),
      embedding: {
        space: this.embeddingSpace,
        entries: Object.fromEntries(this.embeddingEntries),
      },
      llm: {
        model: this.llmModel,
        entries: Object.fromEntries(this.llmEntries),
      },
    };
  }
}

/**
 * 実 `EmbeddingProvider` を包み、入力テキストと返ってきたベクトルの対応を記録する。
 *
 * - `opts`（`AbortOptions`）は delegate へそのまま渡す。
 * - 同じ入力を並列に呼んでも delegate は1回だけ呼ぶ。失敗した呼び出しは memo に残さない。
 *   ⚠ 並列に待っている側は、先に呼んだ側の `opts.signal` の abort も共有する。
 * - delegate が壊れたベクトル（次元の食い違い・有限でない成分）を返したら、記録せずに落とす。
 * - delegate が入力と違う件数のベクトルを返したら、1件も記録せずに落とす（件数がずれると、どの入力にどのベクトルが対応するかが決まらないため）。
 * - 返すベクトルは記録とは別の配列。
 */
export class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly pending = new Map<string, Promise<number[]>>();

  constructor(
    private readonly delegate: EmbeddingProvider,
    private readonly recorder: CassetteRecorder,
  ) {
    this.space = delegate.space;
  }

  async embed(ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    // 一度録った入力は二度叩かない: 実 API の埋め込みはビット単位では再現しないので、録り直すと記録と実行がずれる。
    const toFetch = [
      ...new Set(
        texts.filter(
          (text) => this.recorder.lookupEmbedding(text) === undefined && !this.pending.has(text),
        ),
      ),
    ];
    const mine = new Map<string, Promise<number[]>>();
    if (toFetch.length > 0) {
      const batch = this.delegate.embed(ctx, toFetch, opts);
      toFetch.forEach((text, i) => {
        const one = batch.then((vectors) => {
          if (vectors.length !== toFetch.length) {
            throw new Error(
              "RecordingEmbeddingProvider: 委譲先が入力と違う件数を返した" +
                `（入力 ${toFetch.length} 件 / 出力 ${vectors.length} 件）。記録できない。`,
            );
          }
          const vector = vectors[i];
          assertRecordableVector(vector, this.space.dimensions);
          this.recorder.recordEmbedding(this.space, text, [...vector]);
          return vector;
        });
        mine.set(text, one);
        this.pending.set(text, one);
      });
    }
    try {
      return await Promise.all(
        texts.map(async (text) => {
          const waiting = this.pending.get(text);
          if (waiting !== undefined) {
            return [...(await waiting)];
          }
          const entry = this.recorder.lookupEmbedding(text);
          if (entry === undefined) {
            throw new Error(
              "RecordingEmbeddingProvider: 記録した直後の入力を引けない。記録器が壊れている。",
            );
          }
          return [...entry.vector];
        }),
      );
    } finally {
      // 失敗した Promise を残さない（次の呼び出しが delegate を呼び直せるように）。
      for (const [text, one] of mine) {
        if (this.pending.get(text) === one) this.pending.delete(text);
      }
    }
  }
}

function assertRecordableVector(vector: unknown, dimensions: number): asserts vector is number[] {
  if (!Array.isArray(vector)) {
    throw new Error(
      "RecordingEmbeddingProvider: 委譲先がベクトル（配列）を返さなかった。記録できない。",
    );
  }
  if (vector.length !== dimensions) {
    throw new Error(
      "RecordingEmbeddingProvider: 委譲先のベクトルの次元が space.dimensions と違う" +
        `（${vector.length} 次元 / 宣言 ${dimensions} 次元）。記録できない。`,
    );
  }
  const bad = vector.findIndex((x) => typeof x !== "number" || !Number.isFinite(x));
  if (bad !== -1) {
    throw new Error(
      `RecordingEmbeddingProvider: 委譲先のベクトルに有限でない成分がある（${bad} 番目: ${String(vector[bad])}）。記録できない。`,
    );
  }
}

/**
 * 実 `LLMProvider` を包み、プロンプトと応答の対応を記録する。
 *
 * 🔴 同じプロンプトを二度は叩かない。一度録った鍵は、記録済みの値を返す: 鍵は1つの値しか持てず、実 LLM は同じプロンプトに
 * 毎回違う応答を返すので、後勝ちで先の値が消え、記録が自分を作った実行を再生できなくなる。
 *
 * - 同じプロンプトを並列に呼んでも delegate は1回だけ呼ぶ。失敗した呼び出しは memo に残さない。
 *   ⚠ 並列に待っている側は、先に呼んだ側の `opts.signal` の abort も共有する。
 * - `opts`（`AbortOptions`）は delegate へそのまま渡す。
 * - memo は1回の記録セッションの中でしか効かない。再生（`RecordedLLMProvider`）の代わりではない。
 */
export class RecordingLLMProvider implements LLMProvider {
  private readonly pendingComplete = new Map<string, Promise<LLMResponse>>();
  private readonly pendingStructured = new Map<string, Promise<unknown>>();

  constructor(
    private readonly delegate: LLMProvider,
    private readonly recorder: CassetteRecorder,
    private readonly model: string,
  ) {}

  async complete(ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse> {
    const recorded = this.recorder.lookupLLM(req);
    if (recorded !== undefined) {
      return structuredClone(recorded.value) as LLMResponse;
    }
    const key = llmCassetteKey(req);
    const waiting = this.pendingComplete.get(key);
    if (waiting !== undefined) {
      return structuredClone(await waiting);
    }
    const running = (async () => {
      const response = await this.delegate.complete(ctx, req, opts);
      this.recorder.recordLLM(this.model, req, structuredClone(response));
      return structuredClone(response);
    })();
    this.pendingComplete.set(key, running);
    try {
      return structuredClone(await running);
    } finally {
      this.pendingComplete.delete(key);
    }
  }

  async completeStructured<T>(
    ctx: Ctx,
    req: StructuredRequest<T>,
    opts?: AbortOptions,
  ): Promise<T> {
    const recorded = this.recorder.lookupLLM(req.prompt);
    if (recorded !== undefined) {
      // 鍵にスキーマを含めないので、記録済みの値も呼び出し側の `schema` で検証し直す。
      return req.schema.parse(structuredClone(recorded.value));
    }
    const key = llmCassetteKey(req.prompt);
    const waiting = this.pendingStructured.get(key);
    if (waiting !== undefined) {
      return req.schema.parse(structuredClone(await waiting));
    }
    const running = (async () => {
      const value = await this.delegate.completeStructured(ctx, req, opts);
      // 検証後の値を記録する: 再生側も同じ `schema` で検証し直す。
      this.recorder.recordLLM(this.model, req.prompt, structuredClone(value));
      return structuredClone(value);
    })();
    this.pendingStructured.set(key, running);
    try {
      return structuredClone(await running) as T;
    } finally {
      this.pendingStructured.delete(key);
    }
  }
}
