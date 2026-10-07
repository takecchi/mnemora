import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import OpenAI from "openai";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

/** 本物の `openai` SDK に偽の `fetch` を渡す。SDK は既定で `encoding_format: "base64"` を送り、応答の base64 を Float32 に戻すので、その経路ごと通す。 */
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

// どの検査が落としたかまで固定する（他の検査が肩代わりしても緑にならないように）。
const COUNT = /^OpenAIEmbeddingProvider: .*件のベクトルが返った/;
const RANGE = /^OpenAIEmbeddingProvider: .*index が範囲外/;
const DUP = /^OpenAIEmbeddingProvider: .*index=\d+ が重複/;
const DIM = /^OpenAIEmbeddingProvider: .*次元だった/;
const FINITE = /^OpenAIEmbeddingProvider: .*有限でない成分/;

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
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(COUNT);
  });

  it("件数が多い応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 1, vector: [1, 2] },
      { index: 2, vector: [1, 2] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(COUNT);
  });

  it("data が空の応答は例外", async () => {
    const p = providerReturning([]);
    await expect(p.embed(ctx, ["a"])).rejects.toThrow(COUNT);
  });

  it("index が重複している応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 0, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(DUP);
  });

  it("index が欠けている（0..n-1 でない）応答は例外", async () => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: 2, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(RANGE);
  });

  it("index が範囲外（負）の応答は例外", async () => {
    const p = providerReturning([
      { index: -1, vector: [1, 2] },
      { index: 0, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(RANGE);
  });

  // 次元違いの1件が先頭・中央・最後のどこにあっても断る（「最後だけ検査」「先頭だけ検査」を捕まえる）。
  it.each([0, 1, 2])("次元が違うベクトルが %i 番目にある応答は例外", async (bad) => {
    const items: Item[] = [0, 1, 2].map((i) => ({
      index: i,
      vector: i === bad ? [1, 2, 3] : [1, 2],
    }));
    const p = providerReturning(items);
    await expect(p.embed(ctx, ["a", "b", "c"])).rejects.toThrow(DIM);
  });

  // 整数でない index（小数・NaN）は範囲外として断る（`Number.isInteger` を外すと別の経路の例外になる）。NaN は JSON で null になって届く。
  it.each([0.5, 1.5, Number.NaN])("index が整数でない（%s）応答は範囲外で例外", async (bad) => {
    const p = providerReturning([
      { index: 0, vector: [1, 2] },
      { index: bad, vector: [3, 4] },
    ]);
    await expect(p.embed(ctx, ["a", "b"])).rejects.toThrow(RANGE);
  });

  it("NaN 成分を含む応答は例外", async () => {
    const p = providerReturning([{ index: 0, vector: [1, Number.NaN] }]);
    await expect(p.embed(ctx, ["a"])).rejects.toThrow(FINITE);
  });

  it("Infinity 成分を含む応答は例外", async () => {
    const p = providerReturning([{ index: 0, vector: [Number.POSITIVE_INFINITY, 1] }]);
    await expect(p.embed(ctx, ["a"])).rejects.toThrow(FINITE);
  });

  const SECRET = "SECRET-INPUT-TEXT";
  const ok = (index: number): Item => ({ index, vector: [1, 2] });
  it.each<[string, RegExp, Item[]]>([
    ["件数", COUNT, [ok(0)]],
    ["index 範囲外", RANGE, [ok(0), ok(5)]],
    ["index 非整数", RANGE, [ok(0), ok(0.5)]],
    ["index 重複", DUP, [ok(0), ok(0)]],
    ["次元", DIM, [ok(0), { index: 1, vector: [1, 2, 3] }]],
    ["NaN", FINITE, [ok(0), { index: 1, vector: [1, Number.NaN] }]],
  ])("例外メッセージに入力テキスト本文・キーを含めない（%s）", async (_name, re, items) => {
    const p = providerReturning(items);
    const err = await p.embed(ctx, [SECRET, `${SECRET}-2`]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(re);
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain("sk-fake");
  });
});
