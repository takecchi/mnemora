import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * ADR 0428: provider を**直に**呼んだとき、abort の reject が `signal.reason` そのものであること
 * （ADR 0359 決定4）。`client` に**実物の `@anthropic-ai/sdk`** を注入し、localhost の擬似 HTTP
 * サーバに向ける（実 API・鍵は使わない）。`@mnemora/openai` の同名の歯と同じ形・同じ理由。
 * サーバの挙動はリクエストのヘッダ `x-mode`（`defaultHeaders`）で切り替える。
 */
const ctx: Ctx = { tenantId: "tenant-abort-real" };
const prompt = { messages: [{ role: "user" as const, content: "hi" }] };

let server: Server;
let baseURL: string;
let requestCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requestCount += 1;
    const mode = req.headers["x-mode"];
    if (mode === "hang") {
      return; // 応答しない
    }
    if (mode === "rate-limit") {
      res.writeHead(429, { "retry-after": "3", "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function provider(mode: string): AnthropicLLMProvider {
  return new AnthropicLLMProvider({
    model: "claude-test",
    client: new Anthropic({ apiKey: "sk-test", baseURL, defaultHeaders: { "x-mode": mode } }),
  });
}

const calls = {
  complete: (mode: string, signal: AbortSignal) => provider(mode).complete(ctx, prompt, { signal }),
  completeStructured: (mode: string, signal: AbortSignal) =>
    provider(mode).completeStructured(
      ctx,
      { prompt, schema: z.object({ a: z.string() }) },
      { signal },
    ),
};

describe.each(Object.entries(calls))("実物の Anthropic SDK — %s の abort", (_name, call) => {
  it("呼ぶ前に abort 済みなら、リクエストを送らず reject の値は signal.reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller-reason");
    controller.abort(reason);
    const before = requestCount;

    await expect(call("hang", controller.signal)).rejects.toBe(reason);
    expect(requestCount).toBe(before);
  });

  it("応答待ちの途中で abort すると、reject の値は signal.reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller-reason");
    const promise = call("hang", controller.signal);
    setTimeout(() => controller.abort(reason), 50);

    await expect(promise).rejects.toBe(reason);
  });

  it("reason 無しの abort() でも、reject の値は signal.reason（AbortError の DOMException）", async () => {
    const controller = new AbortController();
    const promise = call("hang", controller.signal);
    setTimeout(() => controller.abort(), 50);

    const outcome = await promise.then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(controller.signal.reason).toBeInstanceOf(DOMException);
    expect(outcome).toBe(controller.signal.reason);
  });

  it("429 + retry-after: 3 の再試行待ちの最中に abort すると、待ち切らずに signal.reason で reject する", async () => {
    const controller = new AbortController();
    const reason = new Error("caller-reason");
    const started = Date.now();
    const promise = call("rate-limit", controller.signal);
    setTimeout(() => controller.abort(reason), 200);

    const outcome = await promise.then(
      () => "resolved",
      (error: unknown) => error,
    );
    // 待ち時間を先に見る（SDK の再試行待ち 3 秒を待ち切っていたら、値の前にここで落ちる）
    expect(Date.now() - started).toBeLessThan(1500);
    expect(outcome).toBe(reason);
  });
});
