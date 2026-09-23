// Issue #389 / ADR 0266: `LLMProvider` の適合 suite（`packages/testkit/src/llm-provider-conformance.ts`）を
// **本物の `OpenAILLMProvider`** に当てる。
//
// ## 🔴 何を測っていて、何を測っていないか（正直に書く）
//
// **測っている**: `packages/core/src/interfaces/llm-provider.ts` が「契約:」として逐語で
// 書いている条項——core・呼び出し側にベンダー固有の型が漏れないこと、失敗時は例外をそのまま
// （同一性を保って）伝播すること、下層をリトライしないこと。`OpenAILLMProvider` が
// 実際に書いたロジック（`choices[0].message.content` からの抽出・`schema.parse` での
// 再検証）がそこを満たすかどうかである。
//
// **測っていない**: HTTP・認証・レート制限、そして**実 API 自身の振る舞い**。注入した client
// は手書きの偽物であり、本物の `openai` SDK ではない（`./call-failure.test.ts` /
// `./embedding-provider.conformance.test.ts` の冒頭と同じ規律）。`new OpenAI()` が既定で持つ
// SDK 内部のリトライも、client を注入している以上この歯を通らない（ADR 0198 の負債 (a) と同じ）。
//
// ⛔ 射程外（`packages/testkit/src/llm-provider-conformance.ts` の doc コメントの通り）:
// `refusal` / `truncated` / `no_content` を core の型へ格上げするかどうか、
// `complete()` の `?? ""` 空文字フォールバックの是非。

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type OpenAI from "openai";
import { describeLLMProviderConformance, type LLMProviderFailureHarness } from "@mnemora/testkit";
import { OpenAILLMProvider } from "../llm-provider.js";

// core が実際に `completeStructured` へ渡すスキーマと同じ形——`.optional()` を含む素朴な object。
const structuredSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
});

/**
 * 🔴🔴 **偽 client の応答（SDK 相当）に、ベンダー固有の余計な欄をわざと載せる。
 * これは意図であって、手抜きではない。**
 *
 * `OpenAILLMProvider.complete` は `{ content: response.choices[0]?.message?.content ?? "" }` と
 * 明示的に組み立てて返しており、`response` をそのまま返しているわけではない。
 * **もし実装が将来 `response` を素通しするように変わったら**、適合 suite の歯1
 * （`Object.keys(response) === ["content"]`）がそれを検出できなければならない。
 * ⟹ 偽 client の応答に `id` / `usage` / `model` / `created` を実際に持たせておく
 * ——**素通ししても緑のままな足場では「漏れていないことを測った」と言えない。**
 * （下の「適合テストの前提」で、この欄が実際に付いていることを固定してある。）
 */
function openaiResponseWithVendorFields(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-vendor-leak-test",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-test",
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content, refusal: null },
      },
    ],
  };
}

/**
 * 🔴🔴 **`completeStructured` の偽応答の JSON にも、schema に無い余計な欄をわざと載せる。
 * これも意図であって、手抜きではない。**
 *
 * `OpenAILLMProvider.completeStructured` は `req.schema.parse(stripNulls(parsedJson))` で
 * 返り値を再検証している（生の JSON を素のキャストで返しているわけではない）。
 * **もし実装が `schema.parse` をやめて `parsedJson as T` のような素のキャストに変わったら**、
 * 適合 suite の歯2（返り値の欄が schema の宣言に収まっている）がそれを検出できなければ
 * ならない。⟹ モデルが返したことにする JSON に `vendorNote`（schema に無いキー）を
 * 実際に持たせておく。
 */
const structuredPayloadWithVendorField = {
  content: "hello from openai",
  digest: "digest-value",
  vendorNote: "openai-only field that structuredSchema does not declare",
};

/**
 * `params.response_format` の有無で `complete` 用と `completeStructured` 用の応答を切り替える
 * 偽 client。**毎回同じ値を返す**ので、`deterministic: true` の歯（同じ入力に同じ出力）は
 * 自明に成立する——それ自体は「実装が決定的である」ことの証明ではなく、
 * 「偽 client が決定的な応答を返している」ことの反映である。
 */
function createSuccessClient(): Pick<OpenAI, "chat"> {
  const create = vi.fn(async (params: { response_format?: unknown }) => {
    if (params.response_format) {
      return openaiResponseWithVendorFields(JSON.stringify(structuredPayloadWithVendorField));
    }
    return openaiResponseWithVendorFields("hello from openai");
  });
  return { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">;
}

function createFailingHarness(error: unknown): LLMProviderFailureHarness {
  const create = vi.fn().mockRejectedValue(error);
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { provider, callCount: () => create.mock.calls.length };
}

/**
 * 🔴 適合テストの前に、**足場が歯を空回りさせていない**ことを測る
 * （`./embedding-provider.conformance.test.ts` の「記録した3本のベクトルは互いに異なる」に
 * 相当する前提）。
 *
 * これが無いと、偽 client から余計な欄がいつの間にか消えたときに、歯1・歯2が
 * 黙って空回りするようになる——「漏れていないことを測っている」つもりで、
 * 実際には何も検査していない状態になる。
 */
describe("適合テストの前提: 足場が歯を空回りさせていない", () => {
  it("偽 client の応答（SDK 相当）は content 以外にベンダー固有の欄を実際に持つ", () => {
    const response = openaiResponseWithVendorFields("x");
    const keys = Object.keys(response);
    expect(keys).toContain("id");
    expect(keys).toContain("usage");
    expect(keys).toContain("model");
    expect(keys).toContain("created");
    expect(keys.length).toBeGreaterThan(1);
  });

  it("completeStructured の偽応答の JSON は、structuredSchema に無い欄を実際に持つ", () => {
    const declared = new Set(Object.keys(structuredSchema.shape));
    expect(declared.has("vendorNote")).toBe(false);
    expect("vendorNote" in structuredPayloadWithVendorField).toBe(true);
  });
});

/**
 * 🔴 **リポ内の歯（ADR 0266 負債7）: `completeStructured` は、schema が宣言した欄を落とさない。**
 *
 * 適合 suite の歯2 は「返り値の欄が schema の宣言に収まっている」を `Object.keys(result)` の
 * 走査として書いているため、`result` が `{}` なら一度も検査せずに緑になる。
 * ⟹ **欄が落ちる変異は、歯2 を素通りする。**ここで「在るべき欄が同じ値で在る」を別に測る。
 *
 * ⚠ **公開 suite（`@mnemora/testkit`）には足していない。**公開 suite の歯を締めると、利用者の
 * 自作 adapter のテストが更新しただけで赤になりうる——`docs/migration-v1.md` は公開 suite の
 * 変更（6・13・15。いずれも必須オプションの追加）を破壊的変更に数えており、同じ害の形である。
 * ⟹ **公開 suite の空振りそのものは残っている**（ADR 0266 追記）。
 */
describe("リポ内の歯（ADR 0266 負債7）: completeStructured は schema が宣言した欄を落とさない", () => {
  const declared = Object.keys(structuredSchema.shape) as (keyof typeof structuredSchema.shape)[];

  it("前提: 偽応答の JSON は、schema が宣言した欄をすべて持つ（持たなければこの歯は空振りする）", () => {
    for (const key of declared) {
      expect(structuredPayloadWithVendorField).toHaveProperty(key);
    }
  });

  it("返り値は、schema が宣言した欄をすべて、偽応答と同じ値で持つ", async () => {
    const provider = new OpenAILLMProvider({ model: "gpt-test", client: createSuccessClient() });

    const result = await provider.completeStructured(
      { tenantId: "llm-provider-required-fields" },
      {
        prompt: { messages: [{ role: "user", content: "hi, structured" }] },
        schema: structuredSchema,
      },
    );

    for (const key of declared) {
      expect(result).toHaveProperty(key, structuredPayloadWithVendorField[key]);
    }
  });
});

describeLLMProviderConformance({
  name: "OpenAILLMProvider",
  createProvider: () => new OpenAILLMProvider({ model: "gpt-test", client: createSuccessClient() }),
  // ⚠ **決定性を与えているのは偽 client の固定応答であって、実 API ではない。**
  // OpenAI の実 API が決定的かどうかは、ここでは一切測っていない
  // （ADR 0095 の `OpenAIEmbeddingProvider` 側の注記と同じ理由。`./live.openai.test.ts` は
  // 別途 `deterministic: false` を宣言している）。
  deterministic: true,
  prompt: { messages: [{ role: "user", content: "hi" }] },
  structured: {
    prompt: { messages: [{ role: "user", content: "hi, structured" }] },
    schema: structuredSchema,
  },
  createFailing: createFailingHarness,
});
