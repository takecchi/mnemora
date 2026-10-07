// 適合 suite を本物の `AnthropicLLMProvider` に当てる。注入した client は手書きの偽物で、HTTP・認証・レート制限・実 API の振る舞いは測らない。client を注入しているので、SDK 内部のリトライもここを通らない。

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { describeLLMProviderConformance, type LLMProviderFailureHarness } from "@mnemora/testkit";
import { AnthropicLLMProvider } from "../llm-provider.js";

// core が実際に `completeStructured` へ渡すスキーマと同じ形（`.optional()` を含む素朴な object）。
const structuredSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
});

/** 偽 client の応答に、ベンダー固有の余計な欄（`id` / `usage` / `stop_reason` / `model`）をわざと載せる。実装が `response` を素通しするように変わったとき、適合 suite の歯がそれを検出できなければならず、素通ししても緑のままな足場では「漏れていないことを測った」と言えない。 */
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

/** `completeStructured` の偽応答の JSON にも、schema に無い欄（`vendorNote`）をわざと載せる。実装が `schema.parse` をやめて素のキャストに変わったとき、適合 suite の歯がそれを検出できなければならない。 */
const structuredPayloadWithVendorField = {
  content: "hello from anthropic",
  digest: "digest-value",
  vendorNote: "anthropic-only field that structuredSchema does not declare",
};

/** 毎回同じ値を返すので、`deterministic: true` の歯は自明に成立する。それは偽 client が決定的であることの反映であり、実装が決定的である証明ではない。 */
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

/** 足場が歯を空回りさせていないことを、適合テストの前に測る。偽 client から余計な欄が消えると、歯が黙って空回りする。 */
describe("適合テストの前提: 偽 client の応答は、ベンダー固有の欄と schema に無い欄を実際に持つ（無いと適合テストが何も確かめないまま緑になる）", () => {
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

/**
 * 公開 suite（`@mnemora/testkit`）には足さず、リポ内の歯にする。公開 suite の歯を締めると、利用者の自作 adapter のテストが更新しただけで赤になりうる。
 * 適合 suite の歯は `Object.keys(result)` の走査なので、`result` が `{}` なら一度も検査せずに緑になる。欄が落ちる変異はそこを素通りするので、「在るべき欄が同じ値で在る」を別に測る。
 */
describe("completeStructured は schema が宣言した欄を落とさない（リポ内の検査。ADR 0266 負債7）", () => {
  const declared = Object.keys(structuredSchema.shape) as (keyof typeof structuredSchema.shape)[];

  it("前提: 偽応答の JSON は、schema が宣言した欄をすべて持つ（持たなければ下の検査は何も確かめないまま緑になる）", () => {
    for (const key of declared) {
      expect(structuredPayloadWithVendorField).toHaveProperty(key);
    }
  });

  it("返り値は、schema が宣言した欄をすべて、偽応答と同じ値で持つ", async () => {
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: createSuccessClient(),
    });

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
  name: "AnthropicLLMProvider",
  createProvider: () =>
    new AnthropicLLMProvider({ model: "claude-test", client: createSuccessClient() }),
  // 決定性を与えているのは偽 client の固定応答であって、実 API ではない。
  deterministic: true,
  prompt: { messages: [{ role: "user", content: "hi" }] },
  structured: {
    prompt: { messages: [{ role: "user", content: "hi, structured" }] },
    schema: structuredSchema,
  },
  createFailing: createFailingHarness,
});
