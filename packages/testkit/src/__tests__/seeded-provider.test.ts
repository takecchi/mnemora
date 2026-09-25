// Issue #691 続き: 「種カセット」から再生し、種に無い入力だけ実 API（delegate）へ流す
// provider の歯。
//
// **固定したい振る舞いは3つ**:
// 1. 種にある入力では delegate（実 API の位置）を一切呼ばない。
// 2. 種に無い入力では delegate を呼び、種から返した分・delegate から返した分の
//    どちらも `CassetteRecorder`（新しいカセット）に記録される——新しいカセットは
//    自己完結し、種への参照を残さない。
// 3. 種のモデル名・埋め込み空間が呼び出し側の期待と食い違えば、構築時に例外になる
//    （黙って混ぜない）。

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

/** delegate（実 API の位置）。呼ばれたら投げる——「種にある入力では real が呼ばれない」を固定する。 */
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

/** delegate（実 API の位置）。呼ばれたら記録して、機械的な応答を返す。 */
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

    // ⭐ delegate は「種に無い」1件だけ呼ばれる。
    expect(delegate.calls).toHaveLength(1);

    // ⭐ 新しいカセット（recorder）は両方のエントリを持つ——「種への参照」ではなく
    // 値そのもの。`CassetteRecorder.toCassette()` は embedding 節も要求するため
    // （LLM 専用のこの歯では埋めていない）、ここでは `lookupLLM`/`llmCount` で見る。
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

  it("埋め込み空間が種と食い違えば構築時に例外", () => {
    const seed = seedEmbeddingSection([]);
    const delegate = new ThrowingEmbeddingProvider();
    const mismatched: EmbeddingSpaceId = { ...SPACE, model: "text-embedding-3-large" };
    expect(
      () => new SeededEmbeddingProvider(delegate, { seed, expectedSpace: mismatched }),
    ).toThrow(/埋め込み空間/);
  });

  it("種から返した分・実 API から返した分の両方が、新しいカセットに記録される（自己完結）", async () => {
    const seed = seedEmbeddingSection([{ text: "種にある文2", vector: [7, 8, 9] }]);
    const delegate = new RespondingEmbeddingProvider();
    const seeded = new SeededEmbeddingProvider(delegate, { seed, expectedSpace: SPACE });
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(seeded, recorder);

    await recording.embed(ctx, ["種にある文2", "種に無い文3"]);

    expect(delegate.calls).toEqual([["種に無い文3"]]);
    // `toCassette()` は llm 節も要求するため（Embedding 専用のこの歯では埋めていない）、
    // ここでは `lookupEmbedding`/`embeddingCount` で見る。
    expect(recorder.embeddingCount).toBe(2);
    expect(recorder.lookupEmbedding("種にある文2")?.vector).toEqual([7, 8, 9]);
    expect(recorder.lookupEmbedding("種に無い文3")?.vector).toEqual(["種に無い文3".length, 0, 0]);
  });
});
