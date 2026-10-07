import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  LLMResponse,
  PromptSpec,
  StructuredRequest,
} from "@mnemora/core";
import {
  CassetteRecorder,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "../__fixtures__/cassette-recorder.js";

const ctx: Ctx = { tenantId: "cassette-recorder-test" };

class NondeterministicLLMProvider implements LLMProvider {
  calls = 0;

  async complete(_ctx: Ctx, _req: PromptSpec): Promise<LLMResponse> {
    this.calls += 1;
    return { content: `応答#${this.calls}` };
  }

  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    this.calls += 1;
    return req.schema.parse({ digest: `要旨#${this.calls}` });
  }
}

class NondeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = {
    provider: "openai",
    model: "fake-embedding",
    dimensions: 2,
  };
  calls = 0;
  embeddedTexts: string[][] = [];

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.embeddedTexts.push([...texts]);
    return texts.map((_t, i) => [this.calls, i]);
  }
}

const prompt: PromptSpec = {
  system: "システム文",
  messages: [{ role: "user", content: "同じ質問" }],
};

describe("RecordingLLMProvider: 同じプロンプトを二度叩かない", () => {
  it("同じプロンプトの2回目以降は、1回目に録った応答をそのまま返す", async () => {
    const delegate = new NondeterministicLLMProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "fake-model");

    const first = await recording.complete(ctx, prompt);
    const second = await recording.complete(ctx, prompt);
    const third = await recording.complete(ctx, prompt);

    expect(first.content).toBe("応答#1");
    expect(second.content).toBe("応答#1");
    expect(third.content).toBe("応答#1");
    expect(delegate.calls).toBe(1);
    expect(recorder.llmCount).toBe(1);
  });

  it("違うプロンプトは別の鍵として、それぞれ1回ずつ録る", async () => {
    const delegate = new NondeterministicLLMProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "fake-model");

    await recording.complete(ctx, prompt);
    await recording.complete(ctx, {
      system: "システム文",
      messages: [{ role: "user", content: "別の質問" }],
    });

    expect(delegate.calls).toBe(2);
    expect(recorder.llmCount).toBe(2);
  });

  it("completeStructured も同じ鍵では二度叩かず、記録済みの値を schema で検証し直す", async () => {
    const delegate = new NondeterministicLLMProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "fake-model");
    const schema = z.object({ digest: z.string() });

    const first = await recording.completeStructured(ctx, { prompt, schema });
    const second = await recording.completeStructured(ctx, { prompt, schema });

    expect(first).toEqual({ digest: "要旨#1" });
    expect(second).toEqual({ digest: "要旨#1" });
    expect(delegate.calls).toBe(1);
  });

  it("🔴 記録は、記録を作った実行そのものを再生できる（後勝ちで先の値が消えない）", async () => {
    const delegate = new NondeterministicLLMProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "fake-model");

    const live = [
      (await recording.complete(ctx, prompt)).content,
      (await recording.complete(ctx, prompt)).content,
      (await recording.complete(ctx, prompt)).content,
    ];

    const entry = recorder.lookupLLM(prompt);
    expect(entry).toBeDefined();
    const recordedContent = (entry?.value as LLMResponse).content;
    for (const seen of live) {
      expect(seen).toBe(recordedContent);
    }
  });
});

describe("RecordingEmbeddingProvider: 同じ入力テキストを二度叩かない", () => {
  it("同じテキストの2回目以降は、1回目に録ったベクトルを返す", async () => {
    const delegate = new NondeterministicEmbeddingProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(delegate, recorder);

    const first = await recording.embed(ctx, ["あ", "い"]);
    const second = await recording.embed(ctx, ["あ", "い"]);

    expect(second).toEqual(first);
    expect(delegate.calls).toBe(1);
    expect(recorder.embeddingCount).toBe(2);
  });

  it("未記録のテキストだけを委譲先へ渡す（既に録ったものは混ぜない）", async () => {
    const delegate = new NondeterministicEmbeddingProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(delegate, recorder);

    await recording.embed(ctx, ["あ"]);
    await recording.embed(ctx, ["あ", "い"]);

    expect(delegate.embeddedTexts).toEqual([["あ"], ["い"]]);
  });

  it("同じ呼び出しの中に同じテキストが重複していても、委譲先へは1回だけ渡す", async () => {
    const delegate = new NondeterministicEmbeddingProvider();
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(delegate, recorder);

    const vectors = await recording.embed(ctx, ["あ", "あ", "い"]);

    expect(delegate.embeddedTexts).toEqual([["あ", "い"]]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[1]);
  });
});
