import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Ctx, LLMProvider, PromptSpec } from "@mnemora/core";
import { CassetteRecorder, RecordingLLMProvider } from "../__fixtures__/cassette-recorder.js";
import { RecordedLLMProvider } from "../__fixtures__/recorded-llm-provider.js";
import { SeededLLMProvider } from "../__fixtures__/seeded-provider.js";

const ctx: Ctx = { tenantId: "llm-isolation" };
const PROMPT: PromptSpec = { messages: [{ role: "user", content: "p" }] };
const loose = z.object({ items: z.array(z.unknown()), meta: z.record(z.string(), z.unknown()) });
const SEED = { items: [{ n: 1 }], meta: { k: { deep: 1 } } };
/** カセットに入れる値は、テストごとに作り直す（入れた値そのものを期待値に使わない）。 */
const seedValue = () => structuredClone(SEED);
Object.freeze(SEED);

function newRecorder() {
  const recorder = new CassetteRecorder();
  recorder.recordEmbedding({ provider: "p", model: "m", dimensions: 3 }, "t", [1, 0, 0]);
  return recorder;
}

function cassette() {
  const recorder = newRecorder();
  recorder.recordLLM("m", PROMPT, { content: "recorded" });
  recorder.recordLLM("m", { messages: [{ role: "user", content: "s" }] }, seedValue());
  return recorder.toCassette().llm!;
}
const STRUCT: PromptSpec = { messages: [{ role: "user", content: "s" }] };
type Wrapped = { name: string; make: () => { provider: LLMProvider; recorded?: () => unknown } };
const noDelegate: LLMProvider = {
  complete: async () => {
    throw new Error("delegate must not be called");
  },
  completeStructured: async () => {
    throw new Error("delegate must not be called");
  },
};

const wrappers: Wrapped[] = [
  {
    name: "Recorded",
    make: () => ({ provider: new RecordedLLMProvider({ section: cassette() }) }),
  },
  {
    name: "Seeded",
    make: () => ({
      provider: new SeededLLMProvider(noDelegate, {
        seed: cassette(),
        expectedModel: "m",
      }),
    }),
  },
  {
    name: "Recording（記録済みの再生）",
    make: () => {
      const recorder = newRecorder();
      recorder.recordLLM("m", PROMPT, { content: "recorded" });
      recorder.recordLLM("m", STRUCT, seedValue());
      return { provider: new RecordingLLMProvider(noDelegate, recorder, "m") };
    },
  },
];

describe("返した応答を書き換えても、次の再生に漏れない", () => {
  it.each(wrappers)("$name: complete", async ({ make }) => {
    const { provider } = make();
    const first = await provider.complete(ctx, PROMPT);
    first.content = "mutated";
    expect((await provider.complete(ctx, PROMPT)).content).toBe("recorded");
  });

  it.each(wrappers)("$name: completeStructured（作り直されない欄）", async ({ make }) => {
    const { provider } = make();
    const first = await provider.completeStructured(ctx, { prompt: STRUCT, schema: loose });
    (first.items[0] as { n: number }).n = 99;
    first.items.push("extra");
    (first.meta.k as { deep: number }).deep = 99;
    expect(await provider.completeStructured(ctx, { prompt: STRUCT, schema: loose })).toEqual(SEED);
  });

  it("Recorded: 同じ呼び出しの2つの戻りは、別のオブジェクト", async () => {
    const provider = new RecordedLLMProvider({ section: cassette() });
    const [a, b] = [await provider.complete(ctx, PROMPT), await provider.complete(ctx, PROMPT)];
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("Recording: delegate の応答を、記録とも呼び出し側とも別のオブジェクトにする", () => {
  const delegate = (): LLMProvider => ({
    complete: async () => ({ content: "live" }),
    completeStructured: (async () => seedValue()) as LLMProvider["completeStructured"],
  });

  it("初回の戻りを書き換えても、記録（カセット）にも次の再生にも漏れない", async () => {
    const recorder = newRecorder();
    const provider = new RecordingLLMProvider(delegate(), recorder, "m");
    const first = await provider.complete(ctx, PROMPT);
    first.content = "mutated";
    const s = await provider.completeStructured(ctx, { prompt: STRUCT, schema: loose });
    (s.items[0] as { n: number }).n = 99;
    expect((await provider.complete(ctx, PROMPT)).content).toBe("live");
    expect(await provider.completeStructured(ctx, { prompt: STRUCT, schema: loose })).toEqual(SEED);
    const written = recorder.toCassette().llm!;
    expect(Object.values(written.entries).map((e) => e.value)).toEqual(
      expect.arrayContaining([{ content: "live" }, SEED]),
    );
  });

  it("並列に待った側の戻りも、別のオブジェクト", async () => {
    const provider = new RecordingLLMProvider(delegate(), new CassetteRecorder(), "m");
    const [a, b] = await Promise.all([
      provider.complete(ctx, PROMPT),
      provider.complete(ctx, PROMPT),
    ]);
    expect(a).not.toBe(b);
    a.content = "mutated";
    expect(b.content).toBe("live");
  });

  it("先に着いた側が、受け取った直後に書き換えても、待っていた側に漏れない", async () => {
    const provider = new RecordingLLMProvider(delegate(), new CassetteRecorder(), "m");
    const first = provider.complete(ctx, PROMPT).then((r) => {
      r.content = "mutated";
      return r;
    });
    const second = provider.complete(ctx, PROMPT);
    await first;
    expect((await second).content).toBe("live");
  });

  it("やりすぎ: 値は等しい（複製しても中身は変わらない）", async () => {
    const provider = new RecordingLLMProvider(delegate(), new CassetteRecorder(), "m");
    expect(await provider.complete(ctx, PROMPT)).toEqual({ content: "live" });
    expect(await provider.completeStructured(ctx, { prompt: STRUCT, schema: loose })).toEqual(SEED);
  });
});
