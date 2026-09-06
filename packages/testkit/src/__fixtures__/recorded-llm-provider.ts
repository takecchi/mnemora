import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { LLMCassetteSection } from "./cassette.js";
import { llmCassetteKey } from "./cassette.js";

/**
 * 記録した実 API の応答を再生する `LLMProvider`（ADR 0051）。
 *
 * **`DeterministicLLMProvider` の代わりではない。**あちらは発話をそのまま content にして
 * 40文字で切るだけで、抽出をしていない。こちらは**本物の `gpt-4o-mini` が実際に返した
 * 抽出結果をそのまま返す**。
 *
 * **記録に無い入力に対しては例外を投げる**（`RecordedEmbeddingProvider` と同じ理由）。
 */
export interface RecordedLLMProviderOptions {
  section: LLMCassetteSection;
  /**
   * 呼び出し側が期待するモデル名。指定すると、記録元と食い違ったときに構築時に落ちる
   * （`RecordedEmbeddingProvider.expectedSpace` と同じ狙い）。
   */
  expectedModel?: string;
}

export class RecordedLLMProvider implements LLMProvider {
  private readonly entries: LLMCassetteSection["entries"];

  constructor(options: RecordedLLMProviderOptions) {
    const { section, expectedModel } = options;
    if (expectedModel !== undefined && section.model !== expectedModel) {
      throw new Error(
        "RecordedLLMProvider: カセットのモデルが、呼び出し側の期待と違う。" +
          `記録: ${section.model}、期待: ${expectedModel}。` +
          "モデルを変えたのなら、記録し直すこと。",
      );
    }
    this.entries = section.entries;
  }

  private lookup(prompt: PromptSpec): { prompt: PromptSpec; value: unknown } {
    const entry = this.entries[llmCassetteKey(prompt)];
    if (entry === undefined) {
      const lastUser = [...prompt.messages].reverse().find((m) => m.role === "user");
      throw new Error(
        "RecordedLLMProvider: このプロンプトは記録に無い（黙って擬似応答へ倒れない）。" +
          `最後の user 発話: ${JSON.stringify(lastUser?.content ?? "(無し)")}。` +
          "probe set や抽出プロンプトを変えたのなら、実キーを設定して記録し直すこと" +
          "（examples/chat の `record` サブコマンド）。",
      );
    }
    return entry;
  }

  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const entry = this.lookup(req);
    if (typeof entry.value !== "object" || entry.value === null || !("content" in entry.value)) {
      throw new Error(
        "RecordedLLMProvider: complete() の記録が LLMResponse の形をしていない。カセットが壊れている。",
      );
    }
    return entry.value as LLMResponse;
  }

  /**
   * **記録した値を、呼び出し側の `schema` で必ず検証し直す。**
   *
   * 鍵にはスキーマを含めていない（`llmCassetteKey` 参照）。そのため、記録したあとに
   * `ExtractionResultSchema` が変わると、**古い形の値が新しいコードへ黙って流れ込む**
   * 経路が生じる。ここで毎回検証することで、その食い違いは「順位が微妙に変わる」ではなく
   * **例外**として現れる。`DeterministicLLMProvider` が `safeParse` で同じことを
   * しているのと同じ規律である。
   */
  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const entry = this.lookup(req.prompt);
    const parsed = req.schema.safeParse(entry.value);
    if (!parsed.success) {
      throw new Error(
        "RecordedLLMProvider: 記録した応答が、いまのスキーマを満たさない。" +
          "記録以降にスキーマが変わっている——記録し直すこと。詳細: " +
          parsed.error.message,
      );
    }
    return parsed.data;
  }
}
