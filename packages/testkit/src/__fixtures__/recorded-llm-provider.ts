import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { LLMCassetteSection } from "./cassette.js";
import { llmCassetteKey } from "./cassette.js";

/**
 * 記録した実 API の応答を再生する `LLMProvider`（ADR 0051）。`DeterministicLLMProvider` と違い、
 * 記録元の本物のモデルが返した抽出結果をそのまま返す。記録に無い入力には例外を投げる。
 */
export interface RecordedLLMProviderOptions {
  /** 再生するカセットの LLM の節。 */
  section: LLMCassetteSection;
  /** 期待するモデル名。指定すると、記録元と食い違ったときに構築時に落ちる。 */
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
    return structuredClone(entry.value) as LLMResponse;
  }

  /** 記録した値を、呼び出し側の `schema` で毎回検証し直す。鍵にスキーマを含めないので、スキーマが変わったときに古い形の値が黙って流れ込むのを防ぐ。 */
  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const entry = this.lookup(req.prompt);
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

/** 例外の文面に載せる入力は先頭 80 文字と全体の長さだけにする: 本文を丸ごと載せると、例外文とそれを写すログが本文で埋まる。 */
function describeRecordedInput(text: string): string {
  const LIMIT = 80;
  const chars = Array.from(text);
  if (chars.length <= LIMIT) return JSON.stringify(text);
  return `${JSON.stringify(chars.slice(0, LIMIT).join(""))}…（全 ${chars.length} 文字）`;
}
