// `RecordingEmbeddingProvider` が返すベクトルと記録するベクトルが、入力のテキストと
// 正しく対応していることを測る専用テスト（Issue #1000）。
//
// `describeEmbeddingProviderConformance`（適合テスト一式）は「同じ入力なら同じ値」「入力順との
// 位置の対応」は見るが、**テキストとベクトルの対応そのもの**は見ない——記憶する包み型が
// 下層の並びを入れ替えて記録すると、入れ替わった対応が以後一貫して返るので一式をすり抜ける
// （PR #1001 の変異試験で実測）。一式に要件を足すかは判断待ちのため（#1000、#809 の方針）、
// 包み型の側をここで押さえる。**`*-conformance.ts` には触らない。**
//
// 期待値は、包まれる側（`DeterministicEmbeddingProvider`）へ**1件ずつ**渡して得たベクトル
// ——並びの取り違えが入り込む余地の無い形——と突き合わせる。

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
