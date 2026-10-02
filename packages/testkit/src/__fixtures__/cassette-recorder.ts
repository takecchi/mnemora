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
 * 実 provider を包んで入出力を記録するデコレータ一式（ADR 0051）。
 *
 * **1回の実行で1つのカセットを作る。**LLM と埋め込みで別々のファイルにしないのは、
 * 両者が同じ1回の記録セッションに属する——同じ probe set・同じ日・同じ API の姿——
 * ことを、ファイルの形として保つためである。片方だけ録り直したカセットは、
 * `recordedAt` が示す時点と中身が食い違う。
 *
 * **記録は「素通し」である。**デコレータは委譲先の戻り値をそのまま返し、
 * 加工しない。加工すると、記録したものと本番が返すものがずれる。
 */
export class CassetteRecorder {
  private readonly embeddingEntries = new Map<string, EmbeddingCassetteEntry>();
  private readonly llmEntries = new Map<string, LLMCassetteEntry>();
  private embeddingSpace: EmbeddingSpaceId | undefined;
  private llmModel: string | undefined;

  /**
   * 埋め込みの1件を記録する。同じ `text` を二度記録すると、後の値で上書きする。
   *
   * **2回目以降の記録で埋め込み空間（`provider`・`model`・`dimensions`）が最初と違えば落とす**（ADR 0452）。後勝ちで上書きすると、
   * 別のモデルのベクトルが1枚のカセットに混ざったまま、ヘッダだけが最後の空間を名乗る。
   */
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

  /**
   * LLM の応答の1件を記録する。同じ `prompt` を二度記録すると、後の値で上書きする。
   * **2回目以降の記録でモデル名が最初と違えば落とす**（ADR 0452。理由は {@link recordEmbedding} と同じ）。
   */
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

  /** 記録した埋め込みの件数（鍵の数。呼び出す時点の値）。 */
  get embeddingCount(): number {
    return this.embeddingEntries.size;
  }

  /** 記録した LLM の応答の件数（鍵の数。呼び出す時点の値）。 */
  get llmCount(): number {
    return this.llmEntries.size;
  }

  /**
   * 既に記録済みの応答を引く（{@link RecordingLLMProvider} が同じプロンプトを
   * 二度叩かないために使う）。⛔ 再生用の口ではない——再生は
   * `RecordedLLMProvider` の役目である。
   */
  lookupLLM(prompt: PromptSpec): { prompt: PromptSpec; value: unknown } | undefined {
    return this.llmEntries.get(llmCassetteKey(prompt));
  }

  /** 既に記録済みのベクトルを引く（{@link RecordingEmbeddingProvider} 用）。 */
  lookupEmbedding(text: string): EmbeddingCassetteEntry | undefined {
    return this.embeddingEntries.get(embeddingCassetteKey(text));
  }

  /**
   * 記録をカセットに固める。
   *
   * **一度も記録が無い節があれば落とす。**空の節を持つカセットを書き出すと、
   * 「録ったつもりで録れていない」ことが、再生時の「記録に無い」例外まで
   * 気づかれない。書き出す側で先に落とす。
   */
  toCassette(now: Date = new Date()): Cassette {
    // **何が起きたかだけでなく、どうすればいいかまで言う。**この失敗の既知の原因は1つに
    // 集中している——`observe()` は `externalId` で重複排除するため、取り込み済みの
    // テナントで記録を走らせると抽出も埋め込みも呼ばれない。実際にこれで一度落ちた
    // （ADR 0051「引き受けた負債4」）ので、その原因を例外本文に載せる。
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
 * ADR 0452:
 * - `opts`（`AbortOptions`）は delegate へそのまま渡す。
 * - **同じ入力を並列に呼んでも、delegate は1回だけ呼ぶ**（進行中の呼び出しも memo する）。呼び出し側が見たベクトルと、
 *   記録に残るベクトルが一致する。失敗した呼び出しは memo に残さない（次の呼び出しは delegate を呼び直す）。
 *   ⚠ 並列に待っている側は、先に呼んだ側の `opts.signal` の abort も共有する（先に呼んだ側が abort すると、待っている側も reject する）。
 * - **delegate が壊れたベクトル（次元が `space.dimensions` と違う・有限でない成分）を返したら、記録せずに落とす**
 *   （`EmbeddingProvider` の約束を delegate が破っている。記録すると、カセットが壊れた値を持つ）。
 * - 返すベクトルは記録とは別の配列（呼び出し側が書き換えても記録に漏れない）。
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
    // ⭐ **一度録った入力は二度叩かない**（`RecordingLLMProvider` と同じ理由——
    // そちらの docstring 参照）。実 API の埋め込みはビット単位では再現しないため
    // （ADR 0051 の実測、最小コサイン 0.998647）、同じ文を録り直すと記録と、
    // その記録が作られた実行そのものがずれる。
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
      // 失敗した Promise を残さない（次の呼び出しが delegate を呼び直せるように）。成功したものは記録に移っている。
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
 * 🔴 **同じプロンプトを二度は叩かない。一度録った鍵は、記録済みの値をそのまま返す。**
 *
 * **理由**（Issue #498 / #506 の記録で実際に踏んだ）: カセットの鍵は
 * プロンプトのハッシュであり（{@link llmCassetteKey}）、**1つの鍵は1つの値しか持てない。**
 * 一方、実 LLM は同じプロンプトに対して毎回違う応答を返す。⟹ 同じプロンプトが
 * 1回の記録の中で複数回現れると、`Map.set` の**後勝ちで先の値が消え**、
 * **その記録は、記録を作った実行そのものを再生できなくなる。**
 *
 * 実例: `answer` ベンチの評価ケース12件のうち3件が同じフィラー発話
 * （「今日はいい天気ですね。」）を含む。実 `gpt-4o-mini` はその同一の抽出プロンプトに
 * 対して digest を `今日はいい天気` / `今日はいい天気である。` / `今日はいい天気です。`
 * と3通りに返した。記録に残るのは最後の1つだけなので、再生時に先の2ケースが組み立てる
 * 回答プロンプトは記録と食い違い、`RecordedLLMProvider` が「記録に無い」で落ちた。
 *
 * ⟹ **記録器が memo として振る舞うことで、記録は自分自身と矛盾しなくなる。**
 * 副次的に、繰り返し分の API 呼び出しと課金も消える。
 *
 * ADR 0452:
 * - **進行中の呼び出しも memo する。**同じプロンプトを並列に呼んでも、delegate は1回だけ呼ばれ、呼び出し側が見た値と記録に残る値が一致する
 *   （以前は逐次の呼び出しでしか成り立たず、並列だと両方が delegate を呼んで後勝ちになった）。失敗した呼び出しは memo に残さない。
 *   ⚠ 並列に待っている側は、先に呼んだ側の `opts.signal` の abort も共有する。
 * - `opts`（`AbortOptions`）は delegate へそのまま渡す。
 *
 * ⛔ **これは再生（`RecordedLLMProvider`）の代わりではない。**memo は1回の記録セッション
 * の中でしか効かず、プロセスを跨がない。
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
    // ADR 0500: 記録の参照を返さず、記録にも呼び出し側が持つ参照を入れない（どちらを書き換えても、もう一方に漏れない）。
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
      // 待っている側と最初の呼び出し側が、同時に同じ参照を受け取らない。誰も触らない写しを、全員が複製して受け取る。
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
      // 記録済みの値も、呼び出し側の `schema` で検証し直す——`RecordedLLMProvider`
      // と同じ規律（鍵にスキーマを含めていないため）。
      return req.schema.parse(structuredClone(recorded.value));
    }
    const key = llmCassetteKey(req.prompt);
    const waiting = this.pendingStructured.get(key);
    if (waiting !== undefined) {
      // 並列に待っていた側も、記録済みの値と同じく自分の `schema` で検証し直す。
      return req.schema.parse(structuredClone(await waiting));
    }
    const running = (async () => {
      const value = await this.delegate.completeStructured(ctx, req, opts);
      // **検証後の値を記録する。**再生側も同じ `schema` で検証し直すため、
      // ここで検証前の生 JSON を持っても意味が無く、むしろ形が二重になる。
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
