// 期待値は、包まれる側へ1件ずつ渡して得たベクトルと突き合わせる（並びの取り違えが入り込む余地の無い形）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { CassetteRecorder, RecordingEmbeddingProvider } from "../__fixtures__/cassette-recorder.js";

const ctx: Ctx = { tenantId: "recording-embedding-mapping" };

async function expectedVector(text: string): Promise<number[]> {
  const [vector] = await new DeterministicEmbeddingProvider().embed(ctx, [text]);
  return vector!;
}

describe("RecordingEmbeddingProvider: テキストとベクトルの対応（Issue #1000）", () => {
  it("複数件を一度に渡すと、各テキストに包まれる側のそのテキストのベクトルが返り、同じ対応で記録される", async () => {
    const recorder = new CassetteRecorder();
    const provider = new RecordingEmbeddingProvider(new DeterministicEmbeddingProvider(), recorder);
    const texts = ["なつめ", "いちじく", "ざくろ"];

    const vectors = await provider.embed(ctx, texts);

    for (const [i, text] of texts.entries()) {
      const expected = await expectedVector(text);
      expect(vectors[i]).toEqual(expected);
      expect(recorder.lookupEmbedding(text)?.vector).toEqual(expected);
    }
  });

  it("一部が記録済み・重複を含む入力でも、取り逃したテキストそれぞれに正しいベクトルが対応する", async () => {
    const recorder = new CassetteRecorder();
    const provider = new RecordingEmbeddingProvider(new DeterministicEmbeddingProvider(), recorder);
    await provider.embed(ctx, ["いちじく"]);
    const texts = ["なつめ", "いちじく", "ざくろ", "なつめ", "びわ"];

    const vectors = await provider.embed(ctx, texts);

    for (const [i, text] of texts.entries()) {
      const expected = await expectedVector(text);
      expect(vectors[i]).toEqual(expected);
      expect(recorder.lookupEmbedding(text)?.vector).toEqual(expected);
    }
  });
});
