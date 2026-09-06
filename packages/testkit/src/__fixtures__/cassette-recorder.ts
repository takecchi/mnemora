import type {
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
 * 実 provider を包んで入出力を記録するデコレータ一式（ADR 0050）。
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

  recordEmbedding(space: EmbeddingSpaceId, text: string, vector: number[]): void {
    this.embeddingSpace = space;
    this.embeddingEntries.set(embeddingCassetteKey(text), { text, vector });
  }

  recordLLM(model: string, prompt: PromptSpec, value: unknown): void {
    this.llmModel = model;
    this.llmEntries.set(llmCassetteKey(prompt), { prompt, value });
  }

  get embeddingCount(): number {
    return this.embeddingEntries.size;
  }

  get llmCount(): number {
    return this.llmEntries.size;
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
    // （ADR 0050「引き受けた負債4」）ので、その原因を例外本文に載せる。
    const hint =
      "記録の実行が API を1回も呼んでいない。よくある原因: 取り込み済みのテナントで " +
      "`record` を走らせた——`observe()` は externalId で重複排除するため、抽出も埋め込みも " +
      "呼ばれない。新しい tenantId で録り直すこと（ADR 0050）。";
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

/** 実 `EmbeddingProvider` を包み、入力テキストと返ってきたベクトルの対応を記録する。 */
export class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;

  constructor(
    private readonly delegate: EmbeddingProvider,
    private readonly recorder: CassetteRecorder,
  ) {
    this.space = delegate.space;
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    const vectors = await this.delegate.embed(ctx, texts);
    if (vectors.length !== texts.length) {
      throw new Error(
        "RecordingEmbeddingProvider: 委譲先が入力と違う件数を返した" +
          `（入力 ${texts.length} 件 / 出力 ${vectors.length} 件）。記録できない。`,
      );
    }
    texts.forEach((text, i) => {
      const vector = vectors[i];
      if (vector !== undefined) {
        this.recorder.recordEmbedding(this.space, text, vector);
      }
    });
    return vectors;
  }
}

/** 実 `LLMProvider` を包み、プロンプトと応答の対応を記録する。 */
export class RecordingLLMProvider implements LLMProvider {
  constructor(
    private readonly delegate: LLMProvider,
    private readonly recorder: CassetteRecorder,
    private readonly model: string,
  ) {}

  async complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const response = await this.delegate.complete(ctx, req);
    this.recorder.recordLLM(this.model, req, response);
    return response;
  }

  async completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const value = await this.delegate.completeStructured(ctx, req);
    // **検証後の値を記録する。**再生側も同じ `schema` で検証し直すため、
    // ここで検証前の生 JSON を持っても意味が無く、むしろ形が二重になる。
    this.recorder.recordLLM(this.model, req.prompt, value);
    return value;
  }
}
