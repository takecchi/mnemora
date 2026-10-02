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
  /** 再生するカセットの LLM の節。 */
  section: LLMCassetteSection;
  /**
   * 呼び出し側が期待するモデル名。指定すると、記録元と食い違ったときに構築時に落ちる
   * （`RecordedEmbeddingProvider.expectedSpace` と同じ狙い）。
   */
  expectedModel?: string | undefined;
}

/**
 * 記録した実 API の応答を再生する `LLMProvider`（ADR 0051）。説明は {@link RecordedLLMProviderOptions} の doc を見ること。
 *
 * 投げるもの: 構築時に `expectedModel` が記録元と食い違えば `Error`。呼び出し時に、記録に無いプロンプト・
 * `LLMResponse` の形をしていない記録は `Error`、`completeStructured` で記録が `schema` に合わなければ `Error`（`ZodError` ではない。zod の詳細はメッセージに載る）。
 */
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
          `最後の user 発話: ${lastUser === undefined ? "(無し)" : describeRecordedInput(lastUser.content)}。` +
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
    // ADR 0500: 記録の参照を返さない（呼び出し側が書き換えても、次の再生に漏れない。本物の provider は呼び出しごとに新しい値を返す）。
    return structuredClone(entry.value) as LLMResponse;
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
    // ADR 0500: 複製を検証する。schema が値を作り直さない欄（`z.unknown()` など）は、記録の参照のまま通り抜けるため。
    const parsed = req.schema.safeParse(structuredClone(entry.value));
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

/**
 * 記録に無かった入力を、例外の文面に載せる形にする。本文を丸ごと載せない——長い発話や
 * 文書を入れると例外文（とそれを写すログ・CI の出力）が本文で埋まるため、先頭 80 文字と
 * 全体の長さだけを出す。どの入力かを見分けるには、これで足りる。
 */
function describeRecordedInput(text: string): string {
  const LIMIT = 80;
  const chars = Array.from(text);
  if (chars.length <= LIMIT) return JSON.stringify(text);
  return `${JSON.stringify(chars.slice(0, LIMIT).join(""))}…（全 ${chars.length} 文字）`;
}
