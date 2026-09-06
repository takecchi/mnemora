import { describe, it, expect } from "vitest";
import { z } from "zod";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * live テスト（本物の OpenAI を叩く。**明示的な opt-in が要る**）。
 *
 * **⚠ 以前は `OPENAI_API_KEY` の有無だけで発火していた。**
 * その結果、キーを環境に持っている人が `pnpm run test` を1回走らせるだけで、
 * **画面から読み取れない形で課金が発生していた**
 * （[ADR 0019 §5c](../../../../docs/decisions/0019-real-openai-measurement-cost.md)
 * がこの事象を記録している。本 PR の作業中にも実際に踏んだ）。
 * **鍵を持っていることは、いま課金してよいという意思表示ではない。**
 *
 * **⟹ 走る条件を2つにした**: `OPENAI_API_KEY` が在り、**かつ**
 * `MNEMORA_LIVE_OPENAI` が空でない値で設定されていること。
 * どちらか一方でも欠ければ skip する。
 *
 * `MNEMORA_LIVE_OPENAI` は**空でない値なら何でも opt-in とみなす**（`1` / `true` / `yes`）。
 * 特定の綴りだけを受け付けて他を黙って無視すると、「設定したのに走らない」という
 * 静かな罠を作る——ここでは「値の解釈」を持たないことでその罠を消している。
 *
 * **CI では走らない。** GitHub Actions のワークフローに `OPENAI_API_KEY` は設定していない
 * ため、CI 上ではこの `describe` ブロックが常に `skipped` として表示される
 * （`it.skipIf` を使う——`describe.skip` や「ファイル自体を読み込まない」形にはしない。
 * これは「skip ではなく走っていないと分かる形にする」という要求を、
 * vitest のレポートに「このテストの名前・このテストが skip されたこと」を必ず出す、
 * という形で満たすための選択である。テスト名を消してしまう `if (!apiKey) return` は
 * 採らない——それだと「1件パスした」という誤った印象を残す）。
 * **opt-in を足してもこの性質は変わらない**——条件が1つ増えただけで、
 * 走らなかったことはレポートに skipped として必ず出る。
 *
 * ローカルで実行するには（**本物の API を叩き、課金が発生する**）:
 *   OPENAI_API_KEY=sk-... MNEMORA_LIVE_OPENAI=1 pnpm --filter @mnemora/openai test
 */
const apiKey = process.env.OPENAI_API_KEY;
const optedIn = (process.env.MNEMORA_LIVE_OPENAI ?? "") !== "";
const live = optedIn && apiKey !== undefined && apiKey !== "";

describe("live: OpenAI (OPENAI_API_KEY と MNEMORA_LIVE_OPENAI の両方が無ければ skipped と表示される)", () => {
  it.skipIf(!live)("OpenAIEmbeddingProvider.embed が実際の次元数のベクトルを返す", async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey,
      model: "text-embedding-3-small",
      dimensions: 64,
    });
    const [vector] = await provider.embed({ tenantId: "live-test" }, ["mnemora live test"]);
    expect(vector).toHaveLength(64);
  });

  it.skipIf(!live)(
    "OpenAILLMProvider.completeStructured が実際の Structured Output を返す",
    async () => {
      const provider = new OpenAILLMProvider({ apiKey, model: "gpt-4o-mini" });
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
    },
  );
});
