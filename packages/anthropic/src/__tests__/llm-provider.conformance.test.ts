// Issue #389 / ADR 0266: `LLMProvider` の適合 suite（`packages/testkit/src/llm-provider-conformance.ts`）を
// **本物の `AnthropicLLMProvider`** に当てる。
//
// ## 🔴 何を測っていて、何を測っていないか（正直に書く）
//
// **測っている**: `packages/core/src/interfaces/llm-provider.ts` が「契約:」として逐語で
// 書いている条項——core・呼び出し側にベンダー固有の型が漏れないこと、失敗時は例外をそのまま
// （同一性を保って）伝播すること、下層をリトライしないこと。`AnthropicLLMProvider` が
// 実際に書いたロジック（`firstTextBlock` での抽出・`schema.parse` での再検証）がそこを
// 満たすかどうかである。
//
// **測っていない**: HTTP・認証・レート制限、そして**実 API 自身の振る舞い**。注入した client
// は手書きの偽物であり、本物の `@anthropic-ai/sdk` ではない（`../call-failure.test.ts` /
// `../provider-parity.test.ts` の冒頭と同じ規律）。`new Anthropic()` が既定で持つ SDK 内部の
// リトライも、client を注入している以上この歯を通らない（ADR 0198 の負債 (a) と同じ）。
//
// ⛔ 射程外（`packages/testkit/src/llm-provider-conformance.ts` の doc コメントの通り）:
// `refusal` / `truncated` / `no_content` を core の型へ格上げするかどうか、
// `complete()` の `?? ""` 空文字フォールバックの是非。

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { describeLLMProviderConformance, type LLMProviderFailureHarness } from "@mnemora/testkit";
import { AnthropicLLMProvider } from "../llm-provider.js";

// core が実際に `completeStructured` へ渡すスキーマ（`extraction.ts` の
// `ExtractionResultSchema` や `strategies/consolidate.ts` の統合スキーマ）と同じ形
// ——`.optional()` を含む素朴な object。
const structuredSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
});

/**
 * 🔴🔴 **偽 client の応答（SDK 相当）に、ベンダー固有の余計な欄をわざと載せる。
 * これは意図であって、手抜きではない。**
 *
 * `AnthropicLLMProvider.complete` は `{ content: firstTextBlock(response.content) ?? "" }` と
 * 明示的に組み立てて返しており、`response` をそのまま返しているわけではない。
 * **もし実装が将来 `response` を素通しするように変わったら**、適合 suite の歯1
 * （`Object.keys(response) === ["content"]`）がそれを検出できなければならない。
 * ⟹ 偽 client の応答に `id` / `usage` / `stop_reason` / `model` を実際に持たせておく
 * ——**素通ししても緑のままな足場では「漏れていないことを測った」と言えない。**
 * （下の「適合テストの前提」で、この欄が実際に付いていることを固定してある。）
 */
function anthropicResponseWithVendorFields(text: string): Record<string, unknown> {
  return {
    id: "msg_vendor_leak_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 7 },
    content: [{ type: "text", text }],
  };
}

/**
 * 🔴🔴 **`completeStructured` の偽応答の JSON にも、schema に無い余計な欄をわざと載せる。
 * これも意図であって、手抜きではない。**
 *
 * `AnthropicLLMProvider.completeStructured` は `req.schema.parse(parsedJson)` で
 * 返り値を再検証している（生の JSON を素のキャストで返しているわけではない）。
 * **もし実装が `schema.parse` をやめて `parsedJson as T` のような素のキャストに変わったら**、
 * 適合 suite の歯2（返り値の欄が schema の宣言に収まっている）がそれを検出できなければ
 * ならない。⟹ モデルが返したことにする JSON に `vendorNote`（schema に無いキー）を
 * 実際に持たせておく。
 */
const structuredPayloadWithVendorField = {
  content: "hello from anthropic",
  digest: "digest-value",
  vendorNote: "anthropic-only field that structuredSchema does not declare",
};

/**
 * `params.output_config` の有無で `complete` 用と `completeStructured` 用の応答を切り替える
 * 偽 client。**毎回同じ値を返す**ので、`deterministic: true` の歯（同じ入力に同じ出力）は
 * 自明に成立する——それ自体は「実装が決定的である」ことの証明ではなく、
 * 「偽 client が決定的な応答を返している」ことの反映である（下の describeLLMProviderConformance
 * 呼び出しのコメントにも同じ注記を置いてある）。
 */
function createSuccessClient(): Pick<Anthropic, "messages"> {
  const create = vi.fn(async (params: { output_config?: unknown }) => {
    if (params.output_config) {
      return anthropicResponseWithVendorFields(JSON.stringify(structuredPayloadWithVendorField));
    }
    return anthropicResponseWithVendorFields("hello from anthropic");
  });
  return { messages: { create } } as unknown as Pick<Anthropic, "messages">;
}

function createFailingHarness(error: unknown): LLMProviderFailureHarness {
  const create = vi.fn().mockRejectedValue(error);
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { provider, callCount: () => create.mock.calls.length };
}

/**
 * 🔴 適合テストの前に、**足場が歯を空回りさせていない**ことを測る
 * （`packages/openai/src/__tests__/embedding-provider.conformance.test.ts` の
 * 「記録した3本のベクトルは互いに異なる」に相当する前提）。
 *
 * これが無いと、偽 client から余計な欄がいつの間にか消えたときに、歯1・歯2が
 * 黙って空回りするようになる——「漏れていないことを測っている」つもりで、
 * 実際には何も検査していない状態になる。
 */
describe("適合テストの前提: 足場が歯を空回りさせていない", () => {
  it("偽 client の応答（SDK 相当）は content 以外にベンダー固有の欄を実際に持つ", () => {
    const response = anthropicResponseWithVendorFields("x");
    const keys = Object.keys(response);
    expect(keys).toContain("id");
    expect(keys).toContain("usage");
    expect(keys).toContain("stop_reason");
    expect(keys).toContain("model");
    expect(keys.length).toBeGreaterThan(1);
  });

  it("completeStructured の偽応答の JSON は、structuredSchema に無い欄を実際に持つ", () => {
    const declared = new Set(Object.keys(structuredSchema.shape));
    expect(declared.has("vendorNote")).toBe(false);
    expect("vendorNote" in structuredPayloadWithVendorField).toBe(true);
  });
});

describeLLMProviderConformance({
  name: "AnthropicLLMProvider",
  createProvider: () =>
    new AnthropicLLMProvider({ model: "claude-test", client: createSuccessClient() }),
  // ⚠ **決定性を与えているのは偽 client の固定応答であって、実 API ではない。**
  // Anthropic の実 API が決定的かどうかは、ここでは一切測っていない
  // （ADR 0095 の `OpenAIEmbeddingProvider` 側の注記と同じ理由）。
  deterministic: true,
  prompt: { messages: [{ role: "user", content: "hi" }] },
  structured: {
    prompt: { messages: [{ role: "user", content: "hi, structured" }] },
    schema: structuredSchema,
  },
  createFailing: createFailingHarness,
});
