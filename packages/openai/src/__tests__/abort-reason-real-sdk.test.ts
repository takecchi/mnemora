import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import OpenAI from "openai";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

/**
 * ADR 0428: provider を**直に**呼んだとき、abort の reject が `signal.reason` そのものであること
 * （ADR 0359 決定4）。`client` に**実物の `openai` SDK** を注入し、localhost の擬似 HTTP サーバに向ける
 * （実 API・鍵は使わない）。既存の `abort-signal.test.ts` の偽 client は「signal を渡し忘れていないか」しか
 * 測れず、SDK が abort を `APIUserAbortError` に化かす穴（と、SDK の再試行待ちが abort で切れない穴）を
 * 通り抜けていた。
 *
 * サーバの挙動は URL のパスではなく、リクエストのヘッダ `x-mode` で切り替える（`defaultHeaders`）。
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
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sdk(mode: string): OpenAI {
  return new OpenAI({ apiKey: "sk-test", baseURL, defaultHeaders: { "x-mode": mode } });
}

const calls = {
  complete: (mode: string, signal: AbortSignal) =>
    new OpenAILLMProvider({ model: "m", client: sdk(mode) }).complete(ctx, prompt, { signal }),
  completeStructured: (mode: string, signal: AbortSignal) =>
    new OpenAILLMProvider({ model: "m", client: sdk(mode) }).completeStructured(
      ctx,
      { prompt, schema: z.object({ a: z.string() }) },
      { signal },
    ),
  embed: (mode: string, signal: AbortSignal) =>
    new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 8,
      client: sdk(mode),
    }).embed(ctx, ["a"], { signal }),
};

describe.each(Object.entries(calls))("実物の openai SDK — %s の abort", (_name, call) => {
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
