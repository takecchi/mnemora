import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
// `anthropic-sdk-latest` は devDependency のエイリアス（`package.json` の
// `"anthropic-sdk-latest": "npm:@anthropic-ai/sdk@0.129.0"`。下の docstring 参照）。
import AnthropicLatest from "anthropic-sdk-latest";
import type { Ctx } from "@mnemora/core";
import type { AnthropicMessagesClient } from "../client-types.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * [Issue #1221](https://github.com/takecchi/mnemora/issues/1221) の歯。`@mnemora/openai` の
 * `client-type-compat.test.ts` と同じ形・同じ理由——詳細はそちらの冒頭コメントを見ること。
 *
 * `AnthropicLLMProviderOptions.client` の型は、`@anthropic-ai/sdk` のクラスを名指ししない
 * 自前の構造型（`client-types.ts`）である。この歯は2つを縛る:
 *
 * 1. **型**: 固定した版（`@anthropic-ai/sdk@0.124.0`）と、利用者が入れうる別の版
 *    （devDependency に `"anthropic-sdk-latest": "npm:@anthropic-ai/sdk@0.129.0"` として
 *    エイリアスした、2026-09-29 時点の最新）の**両方**の `Anthropic` インスタンスが
 *    `AnthropicMessagesClient` に代入できること——この行が `tsc -p tsconfig.json` を
 *    通ること自体が検査である。
 * 2. **実際の呼び出し**: 本物の SDK client（`fetch` を差し替えたもの）を provider に渡し、
 *    実際に送られる URL・method・JSON body が変わっていないことを、固定した版・別の版の
 *    両方で確かめる。
 *
 * ⚠ **ネットワークは叩かない**（`live.anthropic.test.ts` の役目ではない）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

/** 代入できることそのものが検査であるマーカー関数。実行時は何もしない。 */
function assertAssignable<T>(_value: T): void {
  // 意図的に空。呼べる（＝ typecheck が通る）ことが検査である。
}

describe("client の型は別の版の @anthropic-ai/sdk インスタンスも受け付ける（Issue #1221、型検査）", () => {
  it("固定した版（@anthropic-ai/sdk@0.124.0）の Anthropic は AnthropicMessagesClient に代入できる", () => {
    const client: AnthropicMessagesClient = new Anthropic({ apiKey: "sk-ant-test" });
    assertAssignable<AnthropicMessagesClient>(client);
    expect(client).toBeInstanceOf(Anthropic);
  });

  it("別の版（anthropic-sdk-latest = @anthropic-ai/sdk@0.129.0）の Anthropic も代入できる", () => {
    const client: AnthropicMessagesClient = new AnthropicLatest({ apiKey: "sk-ant-test" });
    assertAssignable<AnthropicMessagesClient>(client);
    expect(client).toBeInstanceOf(AnthropicLatest);
  });

  it('Pick<Anthropic, "messages"> 型の値も、引き続き代入できる（既存の偽 client の形を壊さない）', () => {
    const messagesPick: Pick<Anthropic, "messages"> = new Anthropic({ apiKey: "sk-ant-test" });
    assertAssignable<AnthropicMessagesClient>(messagesPick);
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** `fetch` を差し替えた本物の SDK client を作る。捕まえたリクエストは `calls` に積む。 */
function withCapturingFetch<T>(
  buildClient: (fetchStub: typeof fetch) => T,
  respond: () => Response,
): { client: T; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond();
  };
  return { client: buildClient(fetchStub), calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("実際に送られる HTTP は、client の型を切り離す前と変わっていない（Issue #1221、call-shape）", () => {
  it("AnthropicLLMProvider.complete は固定した版の client で messages へ想定どおりの body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new Anthropic({ apiKey: "sk-ant-test", fetch: fetchStub, maxRetries: 0 }),
      () => jsonResponse({ content: [{ type: "text", text: "こんにちは" }], stop_reason: "end_turn" }),
    );
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 16000,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("AnthropicLLMProvider.complete は別の版（anthropic-sdk-latest）の client でも同じ body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) =>
        new AnthropicLatest({ apiKey: "sk-ant-test", fetch: fetchStub, maxRetries: 0 }),
      () => jsonResponse({ content: [{ type: "text", text: "こんにちは" }], stop_reason: "end_turn" }),
    );
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client, maxTokens: 512 });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("AnthropicLLMProvider.completeStructured は output_config.format を載せて POST する（固定した版）", async () => {
    const { z } = await import("zod");
    const schema = z.object({ content: z.string() });
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new Anthropic({ apiKey: "sk-ant-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({
          content: [{ type: "text", text: JSON.stringify({ content: "本文" }) }],
          stop_reason: "end_turn",
        }),
    );
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client });

    const result = await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema,
    });

    expect(result).toEqual({ content: "本文" });
    const body = calls[0]?.body as { output_config?: { format?: { type?: string } } };
    expect(body.output_config?.format?.type).toBe("json_schema");
  });
});
