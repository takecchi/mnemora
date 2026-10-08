import type { Ctx, EmbeddingProvider, LLMProvider, PromptSpec } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Cassette } from "../__fixtures__/cassette.js";
import {
  CASSETTE_FORMAT_VERSION,
  assertCassette,
  embeddingCassetteKey,
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

async function recordRoundTrip(): Promise<Cassette> {
  const recorder = new CassetteRecorder();
  const embedding = new RecordingEmbeddingProvider(new StubEmbeddingProvider(), recorder);
  const llm = new RecordingLLMProvider(new StubLLMProvider(), recorder, "gpt-4o-mini");
  await embedding.embed(ctx, ["青", "みどり"]);
  await llm.completeStructured(ctx, { prompt: PROMPT, schema: SCHEMA });
  return recorder.toCassette();
}

describe("CassetteRecorder（ADR 0051）", () => {
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

describe("RecordedEmbeddingProvider（ADR 0051）", () => {
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
    (cassette.embedding.entries[key] as { vector: number[] }).vector = [1, 2];
    const replay = new RecordedEmbeddingProvider({ section: cassette.embedding });
    const text = cassette.embedding.entries[key]?.text as string;
    await expect(replay.embed(ctx, [text])).rejects.toThrow(/次元が空間と食い違って/);
  });

  it.each([
    ["provider だけ", { ...SPACE, provider: "other" }],
    ["model だけ", { ...SPACE, model: "text-embedding-3-large" }],
    ["dimensions だけ（1つ少ない）", { ...SPACE, dimensions: 2 }],
    ["dimensions だけ（1つ多い）", { ...SPACE, dimensions: 4 }],
  ])("期待する空間と記録元が %s 違っても、構築時に落ちる", async (_label, expectedSpace) => {
    const cassette = await recordRoundTrip();
    expect(
      () => new RecordedEmbeddingProvider({ section: cassette.embedding, expectedSpace }),
    ).toThrow(/埋め込み空間が、呼び出し側の期待と違う/);
  });

  it.each([
    ["後ろ", ["青", "録っていない文"]],
    ["前", ["録っていない文", "青"]],
  ])(
    "記録に無い入力が1つでも（%s）混ざれば、記録にある分も返さずに落ちる",
    async (_label, texts) => {
      const cassette = await recordRoundTrip();
      const replay = new RecordedEmbeddingProvider({ section: cassette.embedding });
      await expect(replay.embed(ctx, texts)).rejects.toThrow(/記録に無い/);
    },
  );

  it("記録されたベクトルが空間より長くても、返さずに落ちる", async () => {
    const cassette = await recordRoundTrip();
    const key = Object.keys(cassette.embedding.entries)[0] as string;
    (cassette.embedding.entries[key] as { vector: number[] }).vector = [1, 2, 3, 4];
    const replay = new RecordedEmbeddingProvider({ section: cassette.embedding });
    const text = cassette.embedding.entries[key]?.text as string;
    await expect(replay.embed(ctx, [text])).rejects.toThrow(/次元が空間と食い違って/);
  });
});

describe("RecordedLLMProvider（ADR 0051）", () => {
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

  it("期待するモデルと記録元が一致すれば、構築でき、記録を再生する", async () => {
    const cassette = await recordRoundTrip();
    const replay = new RecordedLLMProvider({ section: cassette.llm, expectedModel: "gpt-4o-mini" });
    await expect(
      replay.completeStructured(ctx, { prompt: PROMPT, schema: SCHEMA }),
    ).resolves.toEqual({ memories: [{ content: "録った中身" }] });
  });

  it("complete でも、記録に無いプロンプトは擬似応答へ倒れず例外になる", async () => {
    const replay = new RecordedLLMProvider({
      section: {
        model: "m",
        entries: { [llmCassetteKey(PROMPT)]: { prompt: PROMPT, value: { content: "録った応答" } } },
      },
    });
    await expect(replay.complete(ctx, PROMPT)).resolves.toEqual({ content: "録った応答" });
    await expect(
      replay.complete(ctx, { messages: [{ role: "user", content: "録っていない質問" }] }),
    ).rejects.toThrow(/記録に無い/);
  });

  it.each([
    ["null", null],
    ["文字列", "録った応答"],
    ["数", 42],
    ["content の無いオブジェクト", { text: "録った応答" }],
    ["配列", ["録った応答"]],
  ])(
    "complete の記録が LLMResponse の形をしていない（%s）なら、返さずに落ちる",
    async (_label, value) => {
      const replay = new RecordedLLMProvider({
        section: { model: "m", entries: { [llmCassetteKey(PROMPT)]: { prompt: PROMPT, value } } },
      });
      await expect(replay.complete(ctx, PROMPT)).rejects.toThrow(/LLMResponse の形をしていない/);
    },
  );
});

describe("鍵の導出（ADR 0051）", () => {
  it("スキーマを鍵に含めない——同じプロンプトなら同じ鍵になる", () => {
    expect(llmCassetteKey(PROMPT)).toBe(llmCassetteKey({ ...PROMPT }));
  });

  it("system が違えば別の鍵になる", () => {
    expect(llmCassetteKey(PROMPT)).not.toBe(llmCassetteKey({ ...PROMPT, system: "別の指示" }));
  });
});

// 鍵が変わると、利用者が録ったカセットが1件も引けなくなる。期待値は今の実装が返す値を写したもの。
describe("鍵の値は今の値から動かない", () => {
  const hello = { role: "user", content: "こんにちは" } as const;

  it("埋め込みの鍵は入力テキストの UTF-8 の SHA-256 のまま", () => {
    // "abc" と "" は SHA-256 の既知の値と一致する。
    expect(embeddingCassetteKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(embeddingCassetteKey("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(embeddingCassetteKey("私の好きな色は青です。")).toBe(
      "ab709b41562aae6ccba20a6e17b297c528f363345e825beb24c989eeb619c53e",
    );
  });

  it("system の鍵が無いプロンプトと、system が undefined のプロンプトの鍵は今の値のまま", () => {
    const expected = "114ebd7a8ebde81d1135190b5fc273605247ff3e685a9ab4a784250ef0d0ed12";
    expect(llmCassetteKey({ messages: [hello] })).toBe(expected);
    expect(llmCassetteKey({ system: undefined, messages: [hello] })).toBe(expected);
  });

  it("system が空文字のプロンプトの鍵は今の値のまま", () => {
    // ADR 0452 で未着手の A-7。直すと決めたら期待値と形式版を見直す。
    expect(llmCassetteKey({ system: "", messages: [hello] })).toBe(
      "46cc192b296c46e6f40298a308f9398aa2f07fcfabef084b2027ce57e8bbb2b9",
    );
  });

  it("system を持つプロンプトの鍵は今の値のまま", () => {
    expect(llmCassetteKey({ system: "抽出せよ", messages: [hello] })).toBe(
      "9b668903c6d1376638beecd11395309a41ddf1eb163bfaaa014c7ac941070beb",
    );
  });

  it("複数のメッセージの鍵は、順ごとに今の値のまま", () => {
    const a = { role: "user", content: "a" } as const;
    const b = { role: "assistant", content: "b" } as const;
    expect(llmCassetteKey({ system: "抽出せよ", messages: [a, b] })).toBe(
      "c66df844a9063cdfd3efda940e1eb4045988fd39b71d14cd579920f6e390ac59",
    );
    expect(llmCassetteKey({ system: "抽出せよ", messages: [b, a] })).toBe(
      "a2ec41b86f601e8b52b7c5ad002d97caeeea26c6c72b3148fd85f410e84b4ed6",
    );
  });

  it("本文が同じで role だけ違うメッセージの鍵は今の値のまま", () => {
    expect(
      llmCassetteKey({
        system: "抽出せよ",
        messages: [{ role: "assistant", content: "こんにちは" }],
      }),
    ).toBe("0bbedf0bf9346a25da2d1600a6fd3dd8f1c87bff43770dbe2858244d182fdd88");
  });

  it("role が system のメッセージを含むプロンプトの鍵は今の値のまま", () => {
    expect(llmCassetteKey({ messages: [{ role: "system", content: "抽出せよ" }, hello] })).toBe(
      "56e49668c05a834c6fe379f47a00d1c60eb4b419baca6bb339ff06cf34b7e7e3",
    );
  });
});

describe("assertCassette（ADR 0051）", () => {
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
