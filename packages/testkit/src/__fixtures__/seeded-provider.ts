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
import type { EmbeddingCassetteSection, LLMCassetteSection } from "./cassette.js";
import { embeddingCassetteKey, llmCassetteKey } from "./cassette.js";

/**
 * 「種カセット」から実 API を呼ばずに再生し、種に無い入力だけ実 API（delegate）へ渡す
 * provider（Issue #691 続き）。
 *
 * **背景**: `record` は毎回、抽出（`observe()` → `completeStructured`）を実 API でやり直す。
 * 抽出は非決定的なため、録り直すたびに記憶集合（`observe()` が生成する Memory の集合）が
 * 変わりうる——マネージャーが実 API で `record:answer` を走らせた際に実測した
 * （新しい digest が陽性対照 `applyRetentionMutation` の変異対象の部分文字列と
 * 一致しなくなり、変異が「見つからない」で落ちた）。**旧カセットを種として渡し、
 * 同じ入力には同じ記録済み値を返すことで、記憶集合を旧カセットと揃えられる。**
 *
 * **`RecordedLLMProvider`/`RecordedEmbeddingProvider`（{@link ./recorded-llm-provider.js}・
 * {@link ./recorded-embedding-provider.js}）の代わりではない。**あちらは記録に無い入力を
 * 例外にして再生を止める——**こちらは記録に無い入力を実 API（`delegate`）へ流す**、
 * という逆の規律。用途も違う: あちらは北極星の物差しを測る再生経路（記録が全てでなければ
 * ならない）、こちらは `record` サブコマンドが実際に実 API を叩く回数を、既存カセットと
 * 同じ入力についてだけ減らすための下ごしらえである。
 *
 * **記録は別の層（`RecordingLLMProvider`/`RecordingEmbeddingProvider`、
 * {@link ./cassette-recorder.js}）が担う。** `Seeded*Provider` は「種から返すか実 API を
 * 呼ぶか」だけを決め、`Recording*Provider` がその戻り値（種由来か実 API 由来かを問わず）を
 * 新しいカセットへ記録する（`examples/chat/src/providers.ts` の組み立て順:
 * real → `Seeded*Provider` → `Recording*Provider`）。
 * ⟹ **新しいカセットは自己完結する**——種カセットへの参照は一切残らない
 * （値そのものをコピーして持つだけで、種のファイルパスやオブジェクトへの参照は
 * 新しいカセットのどこにも現れない）。
 *
 * **種のモデル名・埋め込み空間が呼び出し側の期待と食い違ったら、構築時に例外にする**
 * （`RecordedLLMProvider.expectedModel`/`RecordedEmbeddingProvider.expectedSpace` と同じ
 * 「黙って混ぜない」規律。ただしこちらは省略できない必須の欄にする——呼び忘れで
 * 食い違ったまま素通りする経路を作らないため）。
 */

/** 種から返した回数と、委譲先（実 API）を呼んだ回数。呼び出し側が画面に出すための実測。 */
export interface SeedUsageCounts {
  /** 種カセットから返した回数。 */
  seeded: number;
  /** 委譲先を呼んだ回数。 */
  real: number;
}

/** {@link SeededLLMProvider} の設定。 */
export interface SeededLLMProviderOptions {
  /** 種にするカセットの LLM の節。 */
  seed: LLMCassetteSection;
  /**
   * 呼び出し側が期待するモデル名。種と食い違えば構築時に落ちる。**必須**
   * （`RecordedLLMProvider.expectedModel` は任意だが、こちらは省略できない）。
   */
  expectedModel: string;
}

/**
 * 種カセットに在るプロンプトは記録済みの応答を返し、無いプロンプトだけを `delegate`（実 API）へ流す `LLMProvider`。
 * 規律はこのファイルの冒頭の doc を見ること。
 *
 * 構築時: 種のモデル名が `expectedModel` と食い違えば `Error` を投げる。
 */
export class SeededLLMProvider implements LLMProvider {
  private readonly entries: LLMCassetteSection["entries"];
  private seededCalls = 0;
  private realCalls = 0;

  constructor(
    private readonly delegate: LLMProvider,
    options: SeededLLMProviderOptions,
  ) {
    const { seed, expectedModel } = options;
    if (seed.model !== expectedModel) {
      throw new Error(
        "SeededLLMProvider: 種カセットのモデルが、今の設定と違う。" +
          `種: ${seed.model}、今の設定: ${expectedModel}。` +
          "黙って混ぜない——同じモデルの種を渡すか、種を外すこと。",
      );
    }
    this.entries = seed.entries;
  }

  /** 種から返した回数・委譲先を呼んだ回数（呼び出す時点の実測。ライブに変わる）。 */
  get usage(): SeedUsageCounts {
    return { seeded: this.seededCalls, real: this.realCalls };
  }

  private lookup(prompt: PromptSpec): { value: unknown } | undefined {
    return this.entries[llmCassetteKey(prompt)];
  }

  async complete(ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse> {
    const entry = this.lookup(req);
    if (entry !== undefined) {
      if (typeof entry.value !== "object" || entry.value === null || !("content" in entry.value)) {
        throw new Error(
          "SeededLLMProvider: complete() の種の記録が LLMResponse の形をしていない。" +
            "種カセットが壊れている。",
        );
      }
      this.seededCalls += 1;
      // ADR 0500: 種の参照を返さない（`RecordedLLMProvider` と同じ）。
      return structuredClone(entry.value) as LLMResponse;
    }
    this.realCalls += 1;
    return this.delegate.complete(ctx, req, opts);
  }

  async completeStructured<T>(
    ctx: Ctx,
    req: StructuredRequest<T>,
    opts?: AbortOptions,
  ): Promise<T> {
    const entry = this.lookup(req.prompt);
    if (entry !== undefined) {
      // `RecordedLLMProvider.completeStructured` と同じ規律——鍵にスキーマを
      // 含めていないため、記録以降にスキーマが変わっていないかをここで検証し直す。
      // ADR 0500: 複製を検証する（`RecordedLLMProvider` と同じ理由）。
      const parsed = req.schema.safeParse(structuredClone(entry.value));
      if (!parsed.success) {
        throw new Error(
          "SeededLLMProvider: 種の記録が、いまのスキーマを満たさない。" +
            "記録以降にスキーマが変わっている可能性がある。詳細: " +
            parsed.error.message,
        );
      }
      this.seededCalls += 1;
      return parsed.data;
    }
    this.realCalls += 1;
    return this.delegate.completeStructured(ctx, req, opts);
  }
}

/** {@link SeededEmbeddingProvider} の設定。 */
export interface SeededEmbeddingProviderOptions {
  /** 種にするカセットの埋め込みの節。 */
  seed: EmbeddingCassetteSection;
  /**
   * 呼び出し側が期待する埋め込み空間。種と食い違えば構築時に落ちる。**必須**
   * （理由は {@link SeededLLMProviderOptions.expectedModel} と同じ）。
   */
  expectedSpace: EmbeddingSpaceId;
}

/**
 * 種カセットに在る入力は記録済みのベクトルを返し、無い入力だけを `delegate`（実 API）へ流す `EmbeddingProvider`。
 * 規律はこのファイルの冒頭の doc を見ること。`space` は `delegate.space` になる。
 *
 * 構築時: 種の空間が `expectedSpace` または `delegate.space` と食い違えば `Error` を投げる（ADR 0452）。
 * `opts`（`AbortOptions`）は委譲先を呼ぶときにそのまま渡す。
 */
export class SeededEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly entries: EmbeddingCassetteSection["entries"];
  private seededCalls = 0;
  private realCalls = 0;

  constructor(
    private readonly delegate: EmbeddingProvider,
    options: SeededEmbeddingProviderOptions,
  ) {
    const { seed, expectedSpace } = options;
    const a = seed.space;
    const b = expectedSpace;
    if (a.provider !== b.provider || a.model !== b.model || a.dimensions !== b.dimensions) {
      throw new Error(
        "SeededEmbeddingProvider: 種カセットの埋め込み空間が、今の設定と違う。" +
          `種: ${a.provider}/${a.model}/${a.dimensions}次元、` +
          `今の設定: ${b.provider}/${b.model}/${b.dimensions}次元。` +
          "黙って混ぜない——同じ空間の種を渡すか、種を外すこと。",
      );
    }
    // ADR 0452: 種の空間と委譲先の空間が食い違ったまま混ぜない。種のベクトルを、別の空間を名乗る `space` の下で返してしまう
    // （`expectedSpace` との照合は、委譲先の空間を見ていなかった）。
    const d = delegate.space;
    if (a.provider !== d.provider || a.model !== d.model || a.dimensions !== d.dimensions) {
      throw new Error(
        "SeededEmbeddingProvider: 種カセットの埋め込み空間が、委譲先（delegate）の空間と違う。" +
          `種: ${a.provider}/${a.model}/${a.dimensions}次元、` +
          `委譲先: ${d.provider}/${d.model}/${d.dimensions}次元。` +
          "黙って混ぜない——同じ空間の委譲先を渡すか、種を外すこと。",
      );
    }
    this.entries = seed.entries;
    this.space = delegate.space;
  }

  /** 種から返した回数・委譲先を呼んだ回数（呼び出す時点の実測。ライブに変わる）。 */
  get usage(): SeedUsageCounts {
    return { seeded: this.seededCalls, real: this.realCalls };
  }

  async embed(ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    texts.forEach((text, i) => {
      const entry = this.entries[embeddingCassetteKey(text)];
      if (entry === undefined) {
        missingIndices.push(i);
        missingTexts.push(text);
        return;
      }
      if (entry.vector.length !== this.space.dimensions) {
        throw new Error(
          "SeededEmbeddingProvider: 種のベクトルの次元が空間と食い違っている。" +
            `種: ${entry.vector.length}次元、空間: ${this.space.dimensions}次元。` +
            "種カセットが壊れている。",
        );
      }
      this.seededCalls += 1;
      // 種の配列そのものは返さない（呼び出し側が書き換えても種に漏れない）。
      results[i] = [...entry.vector];
    });

    if (missingTexts.length > 0) {
      const vectors = await this.delegate.embed(ctx, missingTexts, opts);
      if (vectors.length !== missingTexts.length) {
        throw new Error(
          "SeededEmbeddingProvider: 委譲先が入力と違う件数を返した" +
            `（入力 ${missingTexts.length} 件 / 出力 ${vectors.length} 件）。記録できない。`,
        );
      }
      this.realCalls += missingTexts.length;
      missingIndices.forEach((idx, j) => {
        const vector = vectors[j];
        if (vector !== undefined) {
          results[idx] = vector;
        }
      });
    }

    return results;
  }
}
