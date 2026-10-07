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

/*
 * 「種カセット」から再生し、種に無い入力だけ実 API（delegate）へ渡す provider。`Recorded*` は記録に無い入力を例外にするが、
 * こちらは delegate へ流す（`record` が実 API を叩く回数を、既存カセットと同じ入力について減らすため）。
 * 記録は `Recording*` の層が担い、新しいカセットは自己完結する（種への参照は残らない）。
 * 種のモデル名・埋め込み空間は必須の引数で、食い違えば構築時に落とす: 省略できると、呼び忘れで食い違ったまま素通りする。
 */

/** 種から返した回数と、委譲先を呼んだ回数。 */
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
  /** 期待するモデル名。種と食い違えば構築時に落ちる。`RecordedLLMProvider` と違い必須。 */
  expectedModel: string;
}

/**
 * 種カセットに在るプロンプトは記録済みの応答を返し、無いプロンプトだけを `delegate`（実 API）へ流す `LLMProvider`。
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
      // 鍵にスキーマを含めないので、記録以降のスキーマ変更をここで検証し直す。複製を検証する。
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
  /** 期待する埋め込み空間。種と食い違えば構築時に落ちる。必須。 */
  expectedSpace: EmbeddingSpaceId;
}

/**
 * 種カセットに在る入力は記録済みのベクトルを返し、無い入力だけを `delegate`（実 API）へ流す `EmbeddingProvider`。
 * `space` は `delegate.space` になる。
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
    // 種のベクトルを、別の空間を名乗る `space` の下で返さないよう、委譲先の空間とも照合する。
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
