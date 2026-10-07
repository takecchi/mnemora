import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * 鍵を持っていることは、いま課金してよいという意思表示ではない。`ANTHROPIC_API_KEY` が在り、かつ `MNEMORA_LIVE_ANTHROPIC` が空でない値で設定されているときだけ走る。
 * `MNEMORA_LIVE_ANTHROPIC` は空でない値なら何でも opt-in とみなす。特定の綴りだけ受けて他を黙って無視すると、「設定したのに走らない」罠になる。
 * `it.skipIf` を使う。`if (!apiKey) return` はテスト名が消えず「1件パスした」誤った印象を残し、`describe.skip` やファイルを読み込まない形はテスト名を消す。
 * ローカルで実行するには（本物の API を叩き、課金が発生する）:
 *   ANTHROPIC_API_KEY=sk-ant-... MNEMORA_LIVE_ANTHROPIC=1 pnpm --filter @mnemora/anthropic test
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const optedIn = (process.env.MNEMORA_LIVE_ANTHROPIC ?? "") !== "";
const live = optedIn && apiKey !== undefined && apiKey !== "";

/** パッケージ本体は既定モデルを持たない（`AnthropicLLMProviderOptions.model` は必須）ので、ここはこのテストの裁量値。 */
const LIVE_MODEL = "claude-opus-5";

describe("live: Anthropic (ANTHROPIC_API_KEY と MNEMORA_LIVE_ANTHROPIC の両方が無ければ skipped と表示される)", () => {
  it.skipIf(!live)("AnthropicLLMProvider.complete が実際のテキストを返す", async () => {
    const provider = new AnthropicLLMProvider({ apiKey, model: LIVE_MODEL });
    const result = await provider.complete(
      { tenantId: "live-test" },
      { messages: [{ role: "user", content: "Say hello in one short sentence." }] },
    );
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it.skipIf(!live)("AnthropicLLMProvider.completeStructured が実際の構造化出力を返す", async () => {
    const provider = new AnthropicLLMProvider({ apiKey, model: LIVE_MODEL });
    const schema = z.object({
      greeting: z.string(),
      isFriendly: z.boolean().optional(),
    });
    const result = await provider.completeStructured(
      { tenantId: "live-test" },
      {
        prompt: {
          system: "You return a short greeting as structured JSON.",
          messages: [{ role: "user", content: "Say hello in one short sentence." }],
        },
        schema,
      },
    );
    expect(typeof result.greeting).toBe("string");
    expect(result.greeting.length).toBeGreaterThan(0);
  });
});
