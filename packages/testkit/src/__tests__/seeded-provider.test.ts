import type {
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  LLMResponse,
  PromptSpec,
  StructuredRequest,
} from "@mnemora/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EmbeddingCassetteSection, LLMCassetteSection } from "../__fixtures__/cassette.js";
import { embeddingCassetteKey, llmCassetteKey } from "../__fixtures__/cassette.js";
import {
  CassetteRecorder,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "../__fixtures__/cassette-recorder.js";
import { SeededEmbeddingProvider, SeededLLMProvider } from "../__fixtures__/seeded-provider.js";

const ctx: Ctx = { tenantId: "seeded-provider-test" };

const SPACE: EmbeddingSpaceId = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
};
const MODEL = "gpt-4o-mini";

const SCHEMA = z.object({ digest: z.string() });

class ThrowingLLMProvider implements LLMProvider {
  calls: PromptSpec[] = [];
  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    this.calls.push(req);
    throw new Error("ThrowingLLMProvider.complete: 呼ばれてはいけない（種で足りるはず）");
  }
  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    this.calls.push(req.prompt);
    throw new Error("ThrowingLLMProvider.completeStructured: 呼ばれてはいけない（種で足りるはず）");
  }
}

class RespondingLLMProvider implements LLMProvider {
  calls: PromptSpec[] = [];
  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    this.calls.push(req);
    return { content: "実APIの応答" };
  }
  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    this.calls.push(req.prompt);
    return req.schema.parse({ digest: "実APIのdigest" });
  }
}

class ThrowingEmbeddingProvider implements EmbeddingProvider {
  readonly space = SPACE;
  calls: string[][] = [];
  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    throw new Error("ThrowingEmbeddingProvider.embed: 呼ばれてはいけない(種で足りるはず)");
  }
}

class RespondingEmbeddingProvider implements EmbeddingProvider {
  readonly space = SPACE;
  calls: string[][] = [];
  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((t) => [t.length, 0, 0]);
  }
}

function promptFor(text: string): PromptSpec {
  return { system: "抽出せよ", messages: [{ role: "user", content: text }] };
}

function seedLLMSection(
  entries: Array<{ prompt: PromptSpec; value: unknown }>,
): LLMCassetteSection {
  const out: LLMCassetteSection["entries"] = {};
  for (const e of entries) {
    out[llmCassetteKey(e.prompt)] = e;
  }
  return { model: MODEL, entries: out };
}

function seedEmbeddingSection(
  entries: Array<{ text: string; vector: number[] }>,
): EmbeddingCassetteSection {
  const out: EmbeddingCassetteSection["entries"] = {};
  for (const e of entries) {
    out[embeddingCassetteKey(e.text)] = e;
  }
  return { space: SPACE, entries: out };
}

describe("SeededLLMProvider", () => {
  it("種にある入力では delegate を呼ばない（completeStructured）", async () => {
    const seedPrompt = promptFor("同じ発話");
    const seed = seedLLMSection([{ prompt: seedPrompt, value: { digest: "種のdigest" } }]);
    const delegate = new ThrowingLLMProvider();
    const provider = new SeededLLMProvider(delegate, { seed, expectedModel: MODEL });

    const result = await provider.completeStructured(ctx, { prompt: seedPrompt, schema: SCHEMA });

    expect(result).toEqual({ digest: "種のdigest" });
    expect(delegate.calls).toHaveLength(0);
    expect(provider.usage).toEqual({ seeded: 1, real: 0 });
  });

  it("種にある入力では delegate を呼ばない（complete）", async () => {
    const seedPrompt = promptFor("同じ発話2");
    const seed = seedLLMSection([{ prompt: seedPrompt, value: { content: "種の回答" } }]);
    const delegate = new ThrowingLLMProvider();
    const provider = new SeededLLMProvider(delegate, { seed, expectedModel: MODEL });

    const result = await provider.complete(ctx, seedPrompt);

    expect(result).toEqual({ content: "種の回答" });
    expect(delegate.calls).toHaveLength(0);
    expect(provider.usage).toEqual({ seeded: 1, real: 0 });
  });

  it("種に無い入力では delegate を呼ぶ", async () => {
    const seed = seedLLMSection([]);
    const delegate = new RespondingLLMProvider();
    const provider = new SeededLLMProvider(delegate, { seed, expectedModel: MODEL });

    const missingPrompt = promptFor("種に無い発話");
    const result = await provider.completeStructured(ctx, {
      prompt: missingPrompt,
      schema: SCHEMA,
    });

    expect(result).toEqual({ digest: "実APIのdigest" });
    expect(delegate.calls).toHaveLength(1);
    expect(provider.usage).toEqual({ seeded: 0, real: 1 });
  });

  it("種の記録がいまのスキーマを満たさなければ completeStructured は例外を投げ、seeded を増やさない", async () => {
    const seedPrompt = promptFor("スキーマに合わない種");
    const seed = seedLLMSection([{ prompt: seedPrompt, value: { digest: 123 } }]);
    const delegate = new ThrowingLLMProvider();
    const provider = new SeededLLMProvider(delegate, { seed, expectedModel: MODEL });

    await expect(
      provider.completeStructured(ctx, { prompt: seedPrompt, schema: SCHEMA }),
    ).rejects.toThrow(/いまのスキーマを満たさない/);

    expect(provider.usage).toEqual({ seeded: 0, real: 0 });
    expect(delegate.calls).toHaveLength(0);
  });

  it("モデル名が種と食い違えば構築時に例外", () => {
    const seed = seedLLMSection([]);
    const delegate = new ThrowingLLMProvider();
    expect(() => new SeededLLMProvider(delegate, { seed, expectedModel: "gpt-4o" })).toThrow(
      /モデル/,
    );
  });

  it("種から返した分・実 API から返した分の両方が、新しいカセットに記録される（自己完結）", async () => {
    const seededPrompt = promptFor("種にある発話");
    const missingPrompt = promptFor("種に無い発話・記録用");
    const seed = seedLLMSection([{ prompt: seededPrompt, value: { digest: "種のdigest2" } }]);
    const delegate = new RespondingLLMProvider();
    const seeded = new SeededLLMProvider(delegate, { seed, expectedModel: MODEL });
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(seeded, recorder, MODEL);

    await recording.completeStructured(ctx, { prompt: seededPrompt, schema: SCHEMA });
    await recording.completeStructured(ctx, { prompt: missingPrompt, schema: SCHEMA });

    expect(delegate.calls).toHaveLength(1);

    // `CassetteRecorder.toCassette()` は embedding 節も要求するため（LLM 専用のこの歯では埋めていない）、ここでは `lookupLLM`/`llmCount` で見る。
    expect(recorder.llmCount).toBe(2);
    expect(recorder.lookupLLM(seededPrompt)?.value).toEqual({ digest: "種のdigest2" });
    expect(recorder.lookupLLM(missingPrompt)?.value).toEqual({ digest: "実APIのdigest" });
  });
});

describe("SeededEmbeddingProvider", () => {
  it("種にある入力では delegate を呼ばない", async () => {
    const seed = seedEmbeddingSection([{ text: "同じ文", vector: [1, 2, 3] }]);
    const delegate = new ThrowingEmbeddingProvider();
    const provider = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });

    const result = await provider.embed(ctx, ["同じ文"]);

    expect(result).toEqual([[1, 2, 3]]);
    expect(delegate.calls).toHaveLength(0);
    expect(provider.usage).toEqual({ seeded: 1, real: 0 });
  });

  it("種に無い入力では delegate を呼ぶ", async () => {
    const seed = seedEmbeddingSection([]);
    const delegate = new RespondingEmbeddingProvider();
    const provider = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });

    const result = await provider.embed(ctx, ["種に無い文"]);

    expect(result).toEqual([[5, 0, 0]]);
    expect(delegate.calls).toEqual([["種に無い文"]]);
    expect(provider.usage).toEqual({ seeded: 0, real: 1 });
  });

  it("種にある入力・無い入力が混在すれば、無い分だけ delegate へ渡る", async () => {
    const seed = seedEmbeddingSection([{ text: "種にある文", vector: [9, 9, 9] }]);
    const delegate = new RespondingEmbeddingProvider();
    const provider = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });

    const result = await provider.embed(ctx, ["種にある文", "種に無い文2"]);

    expect(result).toEqual([
      [9, 9, 9],
      ["種に無い文2".length, 0, 0],
    ]);
    expect(delegate.calls).toEqual([["種に無い文2"]]);
    expect(provider.usage).toEqual({ seeded: 1, real: 1 });
  });

  it("1回の embed に種ヒット2件・未ヒット3件を混ぜると、usage は呼び出し回数でなくテキスト件数で { seeded: 2, real: 3 }", async () => {
    const seed = seedEmbeddingSection([
      { text: "種A", vector: [1, 1, 1] },
      { text: "種B", vector: [2, 2, 2] },
    ]);
    const delegate = new RespondingEmbeddingProvider();
    const provider = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });

    await provider.embed(ctx, ["種A", "未1", "種B", "未2", "未3"]);

    expect(delegate.calls).toEqual([["未1", "未2", "未3"]]);
    expect(provider.usage).toEqual({ seeded: 2, real: 3 });
  });

  it("埋め込み空間が種と食い違えば構築時に例外", () => {
    const seed = seedEmbeddingSection([]);
    const delegate = new ThrowingEmbeddingProvider();
    const mismatched: EmbeddingSpaceId = { ...SPACE, model: "text-embedding-3-large" };
    expect(
      () => new SeededEmbeddingProvider(delegate, { seed, expectedSpace: mismatched }),
    ).toThrow(/埋め込み空間/);
  });

  // 委譲先の空間の照合は、種と委譲先が一致していれば何も見ないので、expectedSpace の dimensions の照合が外れても他の歯では見えない。
  it("種・委譲先と同じ3次元で expectedSpace だけ次元が違えば、構築時に例外", () => {
    const seed = seedEmbeddingSection([]);
    const delegate = new ThrowingEmbeddingProvider();
    const wrongDimensions: EmbeddingSpaceId = { ...SPACE, dimensions: 5 };
    expect(
      () => new SeededEmbeddingProvider(delegate, { seed, expectedSpace: wrongDimensions }),
    ).toThrow(/埋め込み空間/);
  });

  // 同上: 種と委譲先が一致していると、expectedSpace の provider の照合が外れても他の歯では見えない。
  it("種・委譲先と同じ空間で expectedSpace だけ provider が違えば、構築時に例外", () => {
    const seed = seedEmbeddingSection([]);
    const delegate = new ThrowingEmbeddingProvider();
    const wrongProvider: EmbeddingSpaceId = { ...SPACE, provider: "local" };
    expect(
      () => new SeededEmbeddingProvider(delegate, { seed, expectedSpace: wrongProvider }),
    ).toThrow(/埋め込み空間/);
  });

  it("委譲先が欠けた入力の件数と違う件数を返したら例外", async () => {
    const seed = seedEmbeddingSection([]);
    const delegate: EmbeddingProvider = {
      space: SPACE,
      embed: async () => [[1, 2, 3]],
    };
    const provider = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });

    await expect(provider.embed(ctx, ["種に無い文A", "種に無い文B"])).rejects.toThrow(
      /委譲先が入力と違う件数を返した/,
    );
  });

  it("種と欠けを交互に混ぜた入力で、戻りが入力の順になる（欠けが2件以上）", async () => {
    const seed = seedEmbeddingSection([
      { text: "種A", vector: [1, 1, 1] },
      { text: "種B", vector: [2, 2, 2] },
    ]);
    const delegate = new RespondingEmbeddingProvider();
    const provider = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });

    const result = await provider.embed(ctx, ["欠け1", "種A", "欠け22", "種B", "欠け333"]);

    expect(result).toEqual([
      ["欠け1".length, 0, 0],
      [1, 1, 1],
      ["欠け22".length, 0, 0],
      [2, 2, 2],
      ["欠け333".length, 0, 0],
    ]);
    expect(delegate.calls).toEqual([["欠け1", "欠け22", "欠け333"]]);
  });

  it("種から返した分・実 API から返した分の両方が、新しいカセットに記録される（自己完結）", async () => {
    const seed = seedEmbeddingSection([{ text: "種にある文2", vector: [7, 8, 9] }]);
    const delegate = new RespondingEmbeddingProvider();
    const seeded = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(seeded, recorder);

    await recording.embed(ctx, ["種にある文2", "種に無い文3"]);

    expect(delegate.calls).toEqual([["種に無い文3"]]);
    // `toCassette()` は llm 節も要求するため（Embedding 専用のこの歯では埋めていない）、ここでは `lookupEmbedding`/`embeddingCount` で見る。
    expect(recorder.embeddingCount).toBe(2);
    expect(recorder.lookupEmbedding("種にある文2")?.vector).toEqual([7, 8, 9]);
    expect(recorder.lookupEmbedding("種に無い文3")?.vector).toEqual(["種に無い文3".length, 0, 0]);
  });
});
