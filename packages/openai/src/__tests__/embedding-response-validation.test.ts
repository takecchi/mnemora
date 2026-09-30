import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import OpenAI from "openai";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

/**
 * `embed()` が応答を検査することの歯（Refs #860、ADR 0305 の 2026-09-30 追記）。
 *
 * 本物の `openai` SDK に偽の `fetch` を渡す。SDK は既定で `encoding_format: "base64"` を送り、
 * 応答の base64 を Float32 に戻す——その経路ごと通したうえで、件数・index・次元・有限性の
 * ずれが例外になることを見る。実 API・ネットワークは使わない。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

type Item = { index: number; vector: number[] };

function b64(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString("base64");
}

function providerReturning(items: Item[], dimensions = 2): OpenAIEmbeddingProvider {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        object: "list",
        model: "text-embedding-3-small",
        data: items.map((i) => ({
          object: "embedding",
          index: i.index,
          embedding: b64(i.vector),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  const client = new OpenAI({ apiKey: "sk-fake", fetch: fakeFetch, maxRetries: 0 });
  return new OpenAIEmbeddingProvider({
    model: "text-embedding-3-small",
    dimensions,
    client,
  });
}

const NAME = /^OpenAIEmbeddingProvider:/;

describe("OpenAIEmbeddingProvider.embed の応答検査", () => {
  it("正常: index が入れ替わっていれば並べ直して返す", async () => {
    const p = providerReturning([
      { index: 1, vector: [0.5, 0.25] },
      { index: 0, vector: [1, 2] },
    ]);
    expect(await p.embed(ctx, ["a", "b"])).toEqual([
      [1, 2],
      [0.5, 0.25],
    ]);
  });

  it("件数が少ない応答は例外", async () => {
    const p = providerReturning([{ index: 0, vector: [1, 2] }]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(NAME);
  });

  it("件数が多い応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 1, vector: [1, 2] },
      { index: 2, vector: [1, 2] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(NAME);
  });

  it("data が空の応答は例外", async () => {
    const p = providerReturning([]);
    await expect(p.embed(ctx, ["a"])).rejects.toThrow(NAME);
  });

  it("index が重複している応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 0, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(NAME);
  });

  it("index が欠けている（0..n-1 でない）応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 2, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(NAME);
  });

  it("index が範囲外（負）の応答は例外", async () => {
    const p = providerReturning([
      { index: -1, vector: [1, 2] },
      { index: 0, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(NAME);
  });

  it("次元が違うベクトルを含む応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 1, vector: [1, 2, 3] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(NAME);
  });

  it("NaN 成分を含む応答は例外", async () => {
    const p = providerReturning([{ index: 0, vector: [1, Number.NaN] }]);
    await expect(p.embed(ctx, ["a"])).rejects.toThrow(NAME);
  });

  it("Infinity 成分を含む応答は例外", async () => {
    const p = providerReturning([{ index: 0, vector: [Number.POSITIVE_INFINITY, 1] }]);
    await expect(p.embed(ctx, ["a"])).rejects.toThrow(NAME);
  });

  it("例外メッセージに入力テキスト本文・キーを含めない", async () => {
    const p = providerReturning([{ index: 0, vector: [1, Number.NaN] }]);
    const err = await p.embed(ctx, ["SECRET-INPUT-TEXT"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(NAME);
    expect(msg).not.toContain("SECRET-INPUT-TEXT");
    expect(msg).not.toContain("sk-fake");
  });
});
