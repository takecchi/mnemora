import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AbortOptions,
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  PromptSpec,
} from "@mnemora/core";
import { assertCassette, embeddingCassetteKey } from "../__fixtures__/cassette.js";
import {
  CassetteRecorder,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "../__fixtures__/cassette-recorder.js";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { RecordedEmbeddingProvider } from "../__fixtures__/recorded-embedding-provider.js";
import { SeededEmbeddingProvider, SeededLLMProvider } from "../__fixtures__/seeded-provider.js";

/**
 * ADR 0452: testkit の fake・カセットを、`EmbeddingProvider`・`LLMProvider` の約束と本物の provider に揃える。
 * 候補ごとに「直す前で赤」と「やりすぎで赤」の歯を持つ（A-1〜A-6・A-8。変異試験の結果は ADR）。
 */

const ctx: Ctx = { tenantId: "provider-fakes-align" };
const SPACE: EmbeddingSpaceId = { provider: "p", model: "m", dimensions: 3 };
const PROMPT: PromptSpec = { messages: [{ role: "user", content: "p" }] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

function embeddingDelegate(
  space: EmbeddingSpaceId = SPACE,
  onCall?: (opts?: AbortOptions) => void,
) {
  let calls = 0;
  const provider: EmbeddingProvider = {
    space,
    embed: async (_ctx, texts, opts) => {
      calls += 1;
      onCall?.(opts);
      await tick();
      return texts.map(() => new Array<number>(space.dimensions).fill(calls));
    },
  };
  return { provider, calls: () => calls };
}

function llmDelegate(onCall?: (opts?: AbortOptions) => void) {
  let calls = 0;
  const provider: LLMProvider = {
    complete: async (_ctx, _req, opts) => {
      calls += 1;
      onCall?.(opts);
      await tick();
      return { content: `response ${calls}` };
    },
    completeStructured: (async (_ctx: Ctx, _req: unknown, opts?: AbortOptions) => {
      calls += 1;
      onCall?.(opts);
      await tick();
      return { value: `response ${calls}` };
    }) as LLMProvider["completeStructured"],
  };
  return { provider, calls: () => calls };
}

const structuredSchema = z.object({ value: z.string() });

function seedFor(space: EmbeddingSpaceId) {
  const recorder = new CassetteRecorder();
  recorder.recordEmbedding(space, "seeded", new Array<number>(space.dimensions).fill(7));
  recorder.recordLLM("m", PROMPT, { content: "seeded" });
  return recorder.toCassette();
}

describe("A-1: SeededEmbeddingProvider は種と delegate の空間の食い違いを構築時に断る", () => {
  it("delegate の model が種と違うと構築で落ちる", () => {
    const seed = seedFor(SPACE);
    const other = embeddingDelegate({ ...SPACE, model: "other" }).provider;
    expect(
      () => new SeededEmbeddingProvider(other, { seed: seed.embedding, expectedSpace: SPACE }),
    ).toThrow(/委譲先/);
  });
  it("delegate の次元が種と違うと構築で落ちる", () => {
    const seed = seedFor(SPACE);
    const other = embeddingDelegate({ ...SPACE, dimensions: 4 }).provider;
    expect(
      () => new SeededEmbeddingProvider(other, { seed: seed.embedding, expectedSpace: SPACE }),
    ).toThrow(/委譲先/);
  });
  it("やりすぎ: 同じ空間なら構築でき、種から返し、無い入力は delegate へ流す", async () => {
    const seed = seedFor(SPACE);
    const d = embeddingDelegate();
    const p = new SeededEmbeddingProvider(d.provider, {
      seed: seed.embedding,
      expectedSpace: SPACE,
    });
    expect(await p.embed(ctx, ["seeded", "miss"])).toEqual([
      [7, 7, 7],
      [1, 1, 1],
    ]);
  });
});

describe("A-2: Seeded*・Recording* は opts をそのまま delegate へ渡す", () => {
  const opts: AbortOptions = { signal: new AbortController().signal };
  it("SeededEmbedding.embed", async () => {
    let got: AbortOptions | undefined;
    const d = embeddingDelegate(SPACE, (o) => (got = o));
    await new SeededEmbeddingProvider(d.provider, {
      seed: seedFor(SPACE).embedding,
      expectedSpace: SPACE,
    }).embed(ctx, ["miss"], opts);
    expect(got).toBe(opts);
  });
  it("SeededLLM.complete / completeStructured", async () => {
    const seen: Array<AbortOptions | undefined> = [];
    const d = llmDelegate((o) => seen.push(o));
    const p = new SeededLLMProvider(d.provider, { seed: seedFor(SPACE).llm, expectedModel: "m" });
    await p.complete(ctx, { messages: [{ role: "user", content: "miss" }] }, opts);
    await p.completeStructured(
      ctx,
      { prompt: { messages: [{ role: "user", content: "miss2" }] }, schema: structuredSchema },
      opts,
    );
    expect(seen).toEqual([opts, opts]);
    expect(seen[0]).toBe(opts);
    expect(seen[1]).toBe(opts);
  });
  it("RecordingEmbedding.embed", async () => {
    let got: AbortOptions | undefined;
    const d = embeddingDelegate(SPACE, (o) => (got = o));
    await new RecordingEmbeddingProvider(d.provider, new CassetteRecorder()).embed(
      ctx,
      ["t"],
      opts,
    );
    expect(got).toBe(opts);
  });
  it("RecordingLLM.complete / completeStructured", async () => {
    const seen: Array<AbortOptions | undefined> = [];
    const d = llmDelegate((o) => seen.push(o));
    const p = new RecordingLLMProvider(d.provider, new CassetteRecorder(), "m");
    await p.complete(ctx, { messages: [{ role: "user", content: "a" }] }, opts);
    await p.completeStructured(
      ctx,
      { prompt: { messages: [{ role: "user", content: "b" }] }, schema: structuredSchema },
      opts,
    );
    expect(seen[0]).toBe(opts);
    expect(seen[1]).toBe(opts);
  });
});

describe("A-3: Recording* は進行中の呼び出しも memo する", () => {
  it("RecordingLLM.complete: 同じプロンプトを並列に呼んでも delegate は1回で、見た値と記録の値が一致する", async () => {
    const d = llmDelegate();
    const recorder = new CassetteRecorder();
    const p = new RecordingLLMProvider(d.provider, recorder, "m");
    const [a, b] = await Promise.all([p.complete(ctx, PROMPT), p.complete(ctx, PROMPT)]);
    expect(d.calls()).toBe(1);
    expect(a).toEqual(b);
    expect(recorder.lookupLLM(PROMPT)?.value).toEqual(a);
  });
  it("RecordingLLM.completeStructured: 並列でも1回。待つ側も自分の schema で検証し直す", async () => {
    const d = llmDelegate();
    const recorder = new CassetteRecorder();
    const p = new RecordingLLMProvider(d.provider, recorder, "m");
    const req = { prompt: PROMPT, schema: structuredSchema };
    const [a, b] = await Promise.all([
      p.completeStructured(ctx, req),
      p.completeStructured(ctx, req),
    ]);
    expect(d.calls()).toBe(1);
    expect(a).toEqual(b);
    expect(recorder.lookupLLM(PROMPT)?.value).toEqual(a);
    // 待つ側の schema が合わなければ、その側だけ落ちる。
    const d2 = llmDelegate();
    const p2 = new RecordingLLMProvider(d2.provider, new CassetteRecorder(), "m");
    const strict = z.object({ other: z.string() });
    const [ok, bad] = await Promise.allSettled([
      p2.completeStructured(ctx, req),
      p2.completeStructured(ctx, { prompt: PROMPT, schema: strict }),
    ]);
    expect(ok.status).toBe("fulfilled");
    expect(bad.status).toBe("rejected");
    expect(d2.calls()).toBe(1);
  });
  it("RecordingEmbedding.embed: 同じテキストを並列に呼んでも delegate は1回で、見たベクトルと記録が一致する", async () => {
    const d = embeddingDelegate();
    const recorder = new CassetteRecorder();
    const p = new RecordingEmbeddingProvider(d.provider, recorder);
    const [a, b] = await Promise.all([p.embed(ctx, ["t"]), p.embed(ctx, ["t"])]);
    expect(d.calls()).toBe(1);
    expect(a).toEqual(b);
    expect(recorder.lookupEmbedding("t")?.vector).toEqual(a[0]);
  });
  it("失敗した Promise は memo に残さない（次の呼び出しは delegate を呼び直す）", async () => {
    let fail = true;
    let calls = 0;
    const llm: LLMProvider = {
      complete: async () => {
        calls += 1;
        await tick();
        if (fail) throw new Error("boom");
        return { content: "ok" };
      },
      completeStructured: async () => {
        throw new Error("unused");
      },
    };
    const p = new RecordingLLMProvider(llm, new CassetteRecorder(), "m");
    const settled = await Promise.allSettled([p.complete(ctx, PROMPT), p.complete(ctx, PROMPT)]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);
    fail = false;
    expect(await p.complete(ctx, PROMPT)).toEqual({ content: "ok" });
    expect(calls).toBe(2);

    let embedFail = true;
    let embedCalls = 0;
    const emb: EmbeddingProvider = {
      space: SPACE,
      embed: async (_c, texts) => {
        embedCalls += 1;
        await tick();
        if (embedFail) throw new Error("boom");
        return texts.map(() => [1, 2, 3]);
      },
    };
    const pe = new RecordingEmbeddingProvider(emb, new CassetteRecorder());
    const s2 = await Promise.allSettled([pe.embed(ctx, ["t"]), pe.embed(ctx, ["t"])]);
    expect(s2.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    embedFail = false;
    expect(await pe.embed(ctx, ["t"])).toEqual([[1, 2, 3]]);
    expect(embedCalls).toBe(2);
  });
  it("やりすぎ: 逐次の繰り返しは今までどおり記録済みを返し、違うプロンプトは別々に delegate を呼ぶ", async () => {
    const d = llmDelegate();
    const p = new RecordingLLMProvider(d.provider, new CassetteRecorder(), "m");
    const first = await p.complete(ctx, PROMPT);
    expect(await p.complete(ctx, PROMPT)).toEqual(first);
    await p.complete(ctx, { messages: [{ role: "user", content: "別" }] });
    expect(d.calls()).toBe(2);
  });
});

describe("A-4: CassetteRecorder は違う空間・モデルの2回目以降を断る", () => {
  it("埋め込み: 違う model・次元は落ちる", () => {
    const r = new CassetteRecorder();
    r.recordEmbedding(SPACE, "a", [1, 2, 3]);
    expect(() => r.recordEmbedding({ ...SPACE, model: "x" }, "b", [1, 2, 3])).toThrow(
      /違う埋め込み空間/,
    );
    expect(() => r.recordEmbedding({ ...SPACE, dimensions: 2 }, "b", [1, 2])).toThrow(
      /違う埋め込み空間/,
    );
  });
  it("LLM: 違うモデル名は落ちる", () => {
    const r = new CassetteRecorder();
    r.recordLLM("A", PROMPT, { content: "1" });
    expect(() =>
      r.recordLLM("B", { messages: [{ role: "user", content: "x" }] }, { content: "2" }),
    ).toThrow(/違うモデル/);
  });
  it("やりすぎ: 同じ空間・モデルの2回目以降は記録できる（同じキーの上書きも）", () => {
    const r = new CassetteRecorder();
    r.recordEmbedding(SPACE, "a", [1, 2, 3]);
    r.recordEmbedding({ ...SPACE }, "b", [4, 5, 6]);
    r.recordEmbedding(SPACE, "a", [7, 8, 9]);
    r.recordLLM("A", PROMPT, { content: "1" });
    r.recordLLM("A", { messages: [{ role: "user", content: "x" }] }, { content: "2" });
    expect(r.embeddingCount).toBe(2);
    expect(r.llmCount).toBe(2);
  });
});

describe("A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる", () => {
  function validCassette() {
    return JSON.parse(JSON.stringify(seedFor(SPACE))) as ReturnType<typeof seedFor>;
  }
  it("やりすぎ: 有限の正しいカセットは読める", () => {
    expect(() => assertCassette(validCassette(), "t")).not.toThrow();
  });
  it.each([null, Number.NaN, "s"])("成分が %s のカセットは読んだ時点で落ちる", (bad) => {
    const c = validCassette();
    const key = Object.keys(c.embedding.entries)[0]!;
    c.embedding.entries[key]!.vector[1] = bad as unknown as number;
    expect(() => assertCassette(c, "t")).toThrow(/有限の数でない/);
  });
  it.each([0, 0.5, -1])("dimensions が %s のカセットは落ちる", (dims) => {
    const c = validCassette();
    c.embedding.space.dimensions = dims;
    expect(() => assertCassette(c, "t")).toThrow(/正の整数/);
  });
  it("embedding の鍵が text の SHA-256 と違うカセットは落ちる", () => {
    const c = validCassette();
    const key = Object.keys(c.embedding.entries)[0]!;
    c.embedding.entries[key]!.text = "書き換えた";
    expect(() => assertCassette(c, "t")).toThrow(/鍵が text/);
  });
  it("llm の鍵が prompt から導いた値と違うカセットは落ちる", () => {
    const c = validCassette();
    const key = Object.keys(c.llm.entries)[0]!;
    c.llm.entries[key]!.prompt = { messages: [{ role: "user", content: "書き換えた" }] };
    expect(() => assertCassette(c, "t")).toThrow(/鍵が prompt/);
  });
  it("RecordedEmbeddingProvider.embed は、成分が有限でない記録を返さずに落ちる（assertCassette を通っていない section でも）", async () => {
    const section = {
      space: SPACE,
      entries: { [embeddingCassetteKey("a")]: { text: "a", vector: [1, Number.NaN, 3] } },
    };
    await expect(new RecordedEmbeddingProvider({ section }).embed(ctx, ["a"])).rejects.toThrow(
      /有限でない/,
    );
  });
  it("やりすぎ: RecordedEmbeddingProvider は有限の記録を返す", async () => {
    const section = {
      space: SPACE,
      entries: { [embeddingCassetteKey("a")]: { text: "a", vector: [1, -0.5, 3] } },
    };
    expect(await new RecordedEmbeddingProvider({ section }).embed(ctx, ["a"])).toEqual([
      [1, -0.5, 3],
    ]);
  });
  it("RecordingEmbedding は delegate の壊れた戻り（NaN・次元違い）を記録せずに落ちる", async () => {
    for (const vector of [
      [1, Number.NaN, 3],
      [1, 2],
    ]) {
      const recorder = new CassetteRecorder();
      const delegate: EmbeddingProvider = {
        space: SPACE,
        embed: async (_c, texts) => texts.map(() => vector),
      };
      await expect(
        new RecordingEmbeddingProvider(delegate, recorder).embed(ctx, ["t"]),
      ).rejects.toThrow(/記録できない/);
      expect(recorder.embeddingCount).toBe(0);
    }
  });
  it("やりすぎ: RecordingEmbedding は有限で次元の合う戻りを記録して返す", async () => {
    const recorder = new CassetteRecorder();
    const delegate: EmbeddingProvider = {
      space: SPACE,
      embed: async (_c, texts) => texts.map(() => [0.25, -1, 3]),
    };
    expect(await new RecordingEmbeddingProvider(delegate, recorder).embed(ctx, ["t"])).toEqual([
      [0.25, -1, 3],
    ]);
    expect(recorder.embeddingCount).toBe(1);
  });
});

describe("A-6: 返すベクトルと space は、記録・構築時の引数と参照を共有しない", () => {
  it("Recorded: 返ったベクトルを書き換えても、次の再生に漏れない。space はカセットのオブジェクトではなく、凍結されている", async () => {
    const section = {
      space: { ...SPACE },
      entries: { [embeddingCassetteKey("a")]: { text: "a", vector: [1, 2, 3] } },
    };
    const p = new RecordedEmbeddingProvider({ section });
    const first = await p.embed(ctx, ["a"]);
    first[0]![0] = 999;
    expect(await p.embed(ctx, ["a"])).toEqual([[1, 2, 3]]);
    expect(p.space).not.toBe(section.space);
    expect(p.space).toEqual(section.space);
    expect(Object.isFrozen(p.space)).toBe(true);
  });
  it("Recording: 返ったベクトルを書き換えても、記録に漏れない", async () => {
    const recorder = new CassetteRecorder();
    const p = new RecordingEmbeddingProvider(embeddingDelegate().provider, recorder);
    const first = await p.embed(ctx, ["t"]);
    first[0]![0] = 999;
    expect(recorder.lookupEmbedding("t")?.vector).toEqual([1, 1, 1]);
    const second = await p.embed(ctx, ["t"]);
    second[0]![1] = 888;
    expect(recorder.lookupEmbedding("t")?.vector).toEqual([1, 1, 1]);
  });
  it("Seeded: 種から返したベクトルを書き換えても、種に漏れない", async () => {
    const seed = seedFor(SPACE);
    const p = new SeededEmbeddingProvider(embeddingDelegate().provider, {
      seed: seed.embedding,
      expectedSpace: SPACE,
    });
    const first = await p.embed(ctx, ["seeded"]);
    first[0]![0] = 999;
    expect(await p.embed(ctx, ["seeded"])).toEqual([[7, 7, 7]]);
  });
  it("Deterministic: 構築後に渡した space を書き換えても、space は動かない", async () => {
    const arg = { provider: "p", model: "m", dimensions: 4 };
    const p = new DeterministicEmbeddingProvider(arg);
    arg.dimensions = 2;
    expect(p.space.dimensions).toBe(4);
    expect((await p.embed(ctx, ["a"]))[0]).toHaveLength(4);
    expect(Object.isFrozen(p.space)).toBe(true);
  });
});

describe("A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "dimensions=%s は構築で落ちる",
    (dimensions) => {
      expect(
        () => new DeterministicEmbeddingProvider({ provider: "p", model: "m", dimensions }),
      ).toThrow(/正の整数/);
    },
  );
  it.each([1, 3, 8, 1536])(
    "やりすぎ: dimensions=%s は構築でき、その次元で返す",
    async (dimensions) => {
      const p = new DeterministicEmbeddingProvider({ provider: "p", model: "m", dimensions });
      expect((await p.embed(ctx, ["a"]))[0]).toHaveLength(dimensions);
    },
  );
  it("既定は8次元", () => {
    expect(new DeterministicEmbeddingProvider().space.dimensions).toBe(8);
  });

  // ADR 0525: 型の誤りは TypeError、範囲の誤りは RangeError。message は同じ。
  const construct = (dimensions: unknown) => () =>
    new DeterministicEmbeddingProvider({
      provider: "p",
      model: "m",
      dimensions: dimensions as number,
    });
  it.each(["8", null, undefined, 8n])("⭐ ADR 0525: dimensions=%s（数でない）は TypeError", (v) => {
    expect(construct(v)).toThrow(TypeError);
    expect(construct(v)).not.toThrow(RangeError);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "⭐ ADR 0525: dimensions=%s（数だが正の整数でない）は RangeError",
    (v) => {
      expect(construct(v)).toThrow(RangeError);
      expect(construct(v)).not.toThrow(TypeError);
    },
  );
  it("⭐ ADR 0525: 型を変えても message は変わらない", () => {
    expect(construct("8")).toThrow(
      "DeterministicEmbeddingProvider: space.dimensions は正の整数でなければならない（8）。",
    );
    expect(construct(1.5)).toThrow(
      "DeterministicEmbeddingProvider: space.dimensions は正の整数でなければならない（1.5）。",
    );
  });
});
