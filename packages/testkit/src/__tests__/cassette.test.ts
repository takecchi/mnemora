// ADR 0050: 記録した実 API の応答を再生する provider の歯。
//
// **ここで固定したい振る舞いは1つに尽きる**——「記録に無いものを訊かれたら、
// 黙って何かを返さずに落ちる」。カセットの価値は「本物と同じ数字が出る」ことにあり、
// 一部が擬似物で埋まった出力は、どの行が信用できるかを誰にも分からなくする。

import type { Ctx, EmbeddingProvider, LLMProvider, PromptSpec } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Cassette } from "../__fixtures__/cassette.js";
import {
  CASSETTE_FORMAT_VERSION,
  assertCassette,
  llmCassetteKey,
} from "../__fixtures__/cassette.js";
import {
  CassetteRecorder,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "../__fixtures__/cassette-recorder.js";
import { RecordedEmbeddingProvider } from "../__fixtures__/recorded-embedding-provider.js";
import { RecordedLLMProvider } from "../__fixtures__/recorded-llm-provider.js";

const ctx: Ctx = { tenantId: "cassette-test" };

const SPACE = { provider: "openai", model: "text-embedding-3-small", dimensions: 3 } as const;

/** 実 provider の代わり。記録側の歯では「本物」の位置に置く。 */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly space = SPACE;
  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    return texts.map((t) => [t.length, 0.5, -0.25]);
  }
}

const SCHEMA = z.object({ memories: z.array(z.object({ content: z.string() })) });

class StubLLMProvider implements LLMProvider {
  async complete(): Promise<{ content: string }> {
    return { content: "stub" };
  }
  async completeStructured<T>(_ctx: Ctx, req: { schema: z.ZodType<T> }): Promise<T> {
    return req.schema.parse({ memories: [{ content: "録った中身" }] });
  }
}

const PROMPT: PromptSpec = {
  system: "抽出せよ",
  messages: [{ role: "user", content: "私の好きな色は青です。" }],
};

/** 記録 → カセット化 → 再生、の往復を1回分作る。 */
async function recordRoundTrip(): Promise<Cassette> {
  const recorder = new CassetteRecorder();
  const embedding = new RecordingEmbeddingProvider(new StubEmbeddingProvider(), recorder);
  const llm = new RecordingLLMProvider(new StubLLMProvider(), recorder, "gpt-4o-mini");
  await embedding.embed(ctx, ["青", "みどり"]);
  await llm.completeStructured(ctx, { prompt: PROMPT, schema: SCHEMA });
  return recorder.toCassette();
}

describe("CassetteRecorder（ADR 0050）", () => {
  it("録ったものを再生すると、記録元と同じベクトルが返る", async () => {
    const cassette = await recordRoundTrip();
    const replay = new RecordedEmbeddingProvider({ section: cassette.embedding });
    expect(await replay.embed(ctx, ["青"])).toEqual([[1, 0.5, -0.25]]);
    expect(await replay.embed(ctx, ["みどり"])).toEqual([[3, 0.5, -0.25]]);
  });

  it("録ったものを再生すると、記録元と同じ構造化応答が返る", async () => {
    const cassette = await recordRoundTrip();
    const replay = new RecordedLLMProvider({ section: cassette.llm });
    expect(await replay.completeStructured(ctx, { prompt: PROMPT, schema: SCHEMA })).toEqual({
      memories: [{ content: "録った中身" }],
    });
  });

  it("埋め込みが1件も記録されていなければ、書き出す前に落ちる", () => {
    const recorder = new CassetteRecorder();
    recorder.recordLLM("gpt-4o-mini", PROMPT, { memories: [] });
    expect(() => recorder.toCassette()).toThrow(/埋め込みが1件も記録されていない/);
  });

  it("LLM 応答が1件も記録されていなければ、書き出す前に落ちる", () => {
    const recorder = new CassetteRecorder();
    recorder.recordEmbedding(SPACE, "青", [1, 2, 3]);
    expect(() => recorder.toCassette()).toThrow(/LLM 応答が1件も記録されていない/);
  });

  it("同じ入力を2回記録しても、entry は1つにまとまる", async () => {
    const recorder = new CassetteRecorder();
    const embedding = new RecordingEmbeddingProvider(new StubEmbeddingProvider(), recorder);
    await embedding.embed(ctx, ["青"]);
    await embedding.embed(ctx, ["青"]);
    expect(recorder.embeddingCount).toBe(1);
  });
});

describe("RecordedEmbeddingProvider（ADR 0050）", () => {
  it("記録に無い入力は、擬似ベクトルへ倒れず例外になる", async () => {
    const cassette = await recordRoundTrip();
    const replay = new RecordedEmbeddingProvider({ section: cassette.embedding });
    await expect(replay.embed(ctx, ["録っていない文"])).rejects.toThrow(/記録に無い/);
  });

  it("期待する空間と記録元が食い違えば、構築時に落ちる", async () => {
    const cassette = await recordRoundTrip();
    expect(
      () =>
        new RecordedEmbeddingProvider({
          section: cassette.embedding,
          expectedSpace: { provider: "openai", model: "text-embedding-3-large", dimensions: 3 },
        }),
    ).toThrow(/埋め込み空間が、呼び出し側の期待と違う/);
  });

  it("期待する空間と記録元が一致すれば、構築できる", async () => {
    const cassette = await recordRoundTrip();
    expect(
      () => new RecordedEmbeddingProvider({ section: cassette.embedding, expectedSpace: SPACE }),
    ).not.toThrow();
  });

  it("記録されたベクトルの次元が空間と食い違えば、「記録に無い」とは別の理由で落ちる", async () => {
    const cassette = await recordRoundTrip();
    const key = Object.keys(cassette.embedding.entries)[0] as string;
    // 記録は在るが中身が壊れている、という状態を作る。
    (cassette.embedding.entries[key] as { vector: number[] }).vector = [1, 2];
    const replay = new RecordedEmbeddingProvider({ section: cassette.embedding });
    const text = cassette.embedding.entries[key]?.text as string;
    await expect(replay.embed(ctx, [text])).rejects.toThrow(/次元が空間と食い違って/);
  });
});

describe("RecordedLLMProvider（ADR 0050）", () => {
  it("記録に無いプロンプトは、擬似応答へ倒れず例外になる", async () => {
    const cassette = await recordRoundTrip();
    const replay = new RecordedLLMProvider({ section: cassette.llm });
    await expect(
      replay.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "録っていない質問" }] },
        schema: SCHEMA,
      }),
    ).rejects.toThrow(/記録に無い/);
  });

  it("記録以降にスキーマが変わっていたら、「記録に無い」とは別の理由で落ちる", async () => {
    const cassette = await recordRoundTrip();
    const replay = new RecordedLLMProvider({ section: cassette.llm });
    // 記録した時点には無かった必須欄をスキーマに足す＝記録が新スキーマを満たさない。
    const tightened = z.object({
      memories: z.array(z.object({ content: z.string(), digest: z.string() })),
    });
    await expect(
      replay.completeStructured(ctx, { prompt: PROMPT, schema: tightened }),
    ).rejects.toThrow(/いまのスキーマを満たさない/);
  });

  it("期待するモデルと記録元が食い違えば、構築時に落ちる", async () => {
    const cassette = await recordRoundTrip();
    expect(
      () => new RecordedLLMProvider({ section: cassette.llm, expectedModel: "gpt-4o" }),
    ).toThrow(/モデルが、呼び出し側の期待と違う/);
  });
});

describe("鍵の導出（ADR 0050）", () => {
  it("スキーマを鍵に含めない——同じプロンプトなら同じ鍵になる", () => {
    expect(llmCassetteKey(PROMPT)).toBe(llmCassetteKey({ ...PROMPT }));
  });

  it("system が違えば別の鍵になる", () => {
    expect(llmCassetteKey(PROMPT)).not.toBe(llmCassetteKey({ ...PROMPT, system: "別の指示" }));
  });
});

describe("assertCassette（ADR 0050）", () => {
  it("形式版が違うカセットは読まずに落ちる", async () => {
    const cassette = (await recordRoundTrip()) as Cassette;
    const stale = { ...cassette, version: CASSETTE_FORMAT_VERSION + 1 };
    expect(() => assertCassette(stale, "テスト")).toThrow(/形式版が違う/);
  });

  it("正しいカセットは通る", async () => {
    const cassette = await recordRoundTrip();
    expect(() => assertCassette(cassette, "テスト")).not.toThrow();
  });

  it("embedding 節が欠けていれば落ちる", async () => {
    const cassette = await recordRoundTrip();
    const broken = { ...cassette, embedding: undefined };
    expect(() => assertCassette(broken, "テスト")).toThrow(/embedding 節が無い/);
  });
});
