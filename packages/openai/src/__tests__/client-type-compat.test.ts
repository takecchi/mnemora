import { describe, expect, it } from "vitest";
import OpenAI from "openai";
// `openai-latest` は devDependency のエイリアス（`package.json` の
// `"openai-latest": "npm:openai@7.23.0"`。下の docstring 参照）。
import OpenAILatest from "openai-latest";
import type { Ctx } from "@mnemora/core";
import type { OpenAIChatClient, OpenAIEmbeddingsClient } from "../client-types.js";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * [Issue #1221](https://github.com/takecchi/mnemora/issues/1221) の歯。
 *
 * `OpenAILLMProviderOptions.client` / `OpenAIEmbeddingProviderOptions.client` の型は、
 * `openai` パッケージのクラスを名指ししない自前の構造型（`client-types.ts`）である。
 * この歯は2つを縛る:
 *
 * 1. **型**: `@mnemora/openai` が依存に固定している版（`openai@7.10.0`、通常の
 *    `import OpenAI from "openai"`）と、利用者が入れうる別の版（devDependency に
 *    `"openai-latest": "npm:openai@7.23.0"` としてエイリアスした、2026-09-29 時点の
 *    最新）の**両方**の `OpenAI` インスタンスが、`OpenAIChatClient`/`OpenAIEmbeddingsClient`
 *    に代入できること。これは実行時の assert ではなく、**この行が
 *    `tsc -p tsconfig.json`（`pnpm run typecheck`）を通ること自体**が検査である
 *    ——型が食い違えば `TS2322` でこのファイルごと typecheck が落ちる。
 * 2. **実際の呼び出し**: 本物の SDK client（`fetch` を差し替えたもの）を provider に
 *    渡し、実際に送られる URL・method・JSON body が変わっていないことを、固定した版・
 *    別の版の両方で確かめる（下の `describe("実際に送られる HTTP …")`）。
 *
 * ⚠ **ネットワークは叩かない**——`fetch` を差し替えて呼び出しを捕まえるだけであり、
 * 本物の OpenAI API への到達性は確かめていない（`live.openai.test.ts` の役目）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

/** 代入できることそのものが検査であるマーカー関数。実行時は何もしない。 */
function assertAssignable<T>(_value: T): void {
  // 意図的に空。呼べる（＝ typecheck が通る）ことが検査である。
}

describe("client の型は別の版の openai インスタンスも受け付ける（Issue #1221、型検査）", () => {
  it("固定した版（openai@7.10.0）の OpenAI は OpenAIChatClient に代入できる", () => {
    const client: OpenAIChatClient = new OpenAI({ apiKey: "sk-test" });
    assertAssignable<OpenAIChatClient>(client);
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("別の版（openai-latest = openai@7.23.0）の OpenAI も OpenAIChatClient に代入できる", () => {
    const client: OpenAIChatClient = new OpenAILatest({ apiKey: "sk-test" });
    assertAssignable<OpenAIChatClient>(client);
    expect(client).toBeInstanceOf(OpenAILatest);
  });

  it("固定した版の OpenAI は OpenAIEmbeddingsClient にも代入できる", () => {
    const client: OpenAIEmbeddingsClient = new OpenAI({ apiKey: "sk-test" });
    assertAssignable<OpenAIEmbeddingsClient>(client);
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("別の版の OpenAI も OpenAIEmbeddingsClient に代入できる", () => {
    const client: OpenAIEmbeddingsClient = new OpenAILatest({ apiKey: "sk-test" });
    assertAssignable<OpenAIEmbeddingsClient>(client);
    expect(client).toBeInstanceOf(OpenAILatest);
  });

  it("Pick<OpenAI, \"chat\">/Pick<OpenAI, \"embeddings\"> 型の値も、引き続き代入できる（既存の偽 client の形を壊さない）", () => {
    const chatPick: Pick<OpenAI, "chat"> = new OpenAI({ apiKey: "sk-test" });
    const embedPick: Pick<OpenAI, "embeddings"> = new OpenAI({ apiKey: "sk-test" });
    assertAssignable<OpenAIChatClient>(chatPick);
    assertAssignable<OpenAIEmbeddingsClient>(embedPick);
  });
});

/** `Float32Array` を OpenAI の base64 埋め込みエンコーディングへ変換する
 * （SDK が既定で `encoding_format: "base64"` を強制し、応答をデコードして返す。
 * `lib/embeddings.js` 参照。実測は PR 本文）。 */
function toBase64Float32(values: number[]): string {
  const buf = new Float32Array(values);
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64");
}

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
  it("OpenAILLMProvider.complete は固定した版の client で chat/completions へ想定どおりの body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAI({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () => jsonResponse({ choices: [{ message: { content: "こんにちは" } }] }),
    );
    const provider = new OpenAILLMProvider({ model: "gpt-4o-mini", client });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("OpenAILLMProvider.complete は別の版（openai-latest）の client でも同じ body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAILatest({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () => jsonResponse({ choices: [{ message: { content: "こんにちは" } }] }),
    );
    const provider = new OpenAILLMProvider({ model: "gpt-4o-mini", client });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("OpenAIEmbeddingProvider.embed は固定した版の client で embeddings へ想定どおりの body を POST し、応答を正しく復元する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAI({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({
          data: [{ embedding: toBase64Float32([0.1, 0.2, 0.3]), index: 0 }],
          model: "text-embedding-3-small",
          object: "list",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
    );
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 3,
      client,
    });

    const [vector] = await provider.embed(ctx, ["hello"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 3,
      encoding_format: "base64",
    });
    expect(vector).toHaveLength(3);
    expect(vector?.[0]).toBeCloseTo(0.1, 5);
    expect(vector?.[1]).toBeCloseTo(0.2, 5);
    expect(vector?.[2]).toBeCloseTo(0.3, 5);
  });

  it("OpenAIEmbeddingProvider.embed は別の版（openai-latest）の client でも同じ body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAILatest({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({
          data: [{ embedding: toBase64Float32([0.4, 0.5]), index: 0 }],
          model: "text-embedding-3-small",
          object: "list",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
    );
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client,
    });

    const [vector] = await provider.embed(ctx, ["hello"]);

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 2,
      encoding_format: "base64",
    });
    expect(vector?.[0]).toBeCloseTo(0.4, 5);
    expect(vector?.[1]).toBeCloseTo(0.5, 5);
  });
});
