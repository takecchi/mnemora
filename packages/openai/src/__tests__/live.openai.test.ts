import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 鍵を持っていることは、いま課金してよいという意思表示ではない。`OPENAI_API_KEY` が在り、かつ `MNEMORA_LIVE_OPENAI` が空でない値で設定されているときだけ走る。
 * `MNEMORA_LIVE_OPENAI` は空でない値なら何でも opt-in とみなす。特定の綴りだけ受けて他を黙って無視すると、「設定したのに走らない」罠になる。
 * `it.skipIf` を使う。`describe.skip` やファイルを読み込まない形、`if (!apiKey) return` は、skipped がレポートに出なかったり「1件パスした」誤った印象を残したりする。
 * ローカルで実行するには（本物の API を叩き、課金が発生する）:
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

/**
 * `deterministic: false` を宣言する。実 API が同じ入力に同じベクトルを返す保証が無く、実測でも3件バッチでは別のベクトルが返った。決定性に依存する2本は `it.skip` として名前が残るので、「そもそも歯が無い」と「走って通った」をログ上で区別できる。実 API の再現性を実測したときだけ、測定の記録と一緒に `true` へ変えること。
 * live を1回走らせるごとに `embeddings.create` の呼び出しが5回増える。二重の opt-in の内側であることが前提。
 */
describe.skipIf(!live)(
  "live: 実 API に対する EmbeddingProvider 適合テスト（ADR 0095 / Issue #116）",
  () => {
    describeEmbeddingProviderConformance({
      name: "OpenAIEmbeddingProvider（実 API）",
      createProvider: () =>
        new OpenAIEmbeddingProvider({
          apiKey,
          model: "text-embedding-3-small",
          dimensions: 256,
        }),
      deterministic: false,
      // 互いに違う短い文字列にする。「3件渡して3件返る」を測る以上、同じ文字列を並べる意味は無い。
      texts: { a: "mnemora conformance a", b: "mnemora conformance b", c: "mnemora conformance c" },
      // `overLimitText` はここでも渡さない。渡すと `docs/conformance.md`「無条件7本」の数え方（決定性2本＋overLimitText 未指定1本を除いた7本）が8本に動くので、足すなら数え方も一緒に直すこと。

      // ネットワーク往復は vitest の既定（5秒）に収まらないことがある。
      timeout: 60_000,
    });
  },
);
