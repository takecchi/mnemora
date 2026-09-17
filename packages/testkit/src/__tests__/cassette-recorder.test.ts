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

/**
 * 🔴 **記録器が、同じ鍵に対して2つ目の値を録らないことを固定する。**
 *
 * カセットの鍵はプロンプト（/ 入力テキスト）のハッシュであり、**1つの鍵は1つの値しか
 * 持てない。**一方、実 LLM は同じプロンプトに毎回違う応答を返す。⟹ 記録中に同じ
 * プロンプトが複数回現れると、後勝ちで先の値が消え、**その記録は、記録を作った実行
 * そのものを再生できなくなる。**
 *
 * この歯は、その壊れ方を「非決定的な偽 provider」で再現し、記録器が memo として
 * 振る舞うことで消えることを機械で止める（Issue #498 / #506 の記録で実際に踏んだ）。
 */

const ctx: Ctx = { tenantId: "cassette-recorder-test" };

/** 呼ばれるたびに違う応答を返す偽 LLM——実 `gpt-4o-mini` の揺れを模す。 */
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

/** 呼ばれるたびに違うベクトルを返す偽 embedding——ADR 0051 が実測した揺れを模す。 */
class NondeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = { model: "fake-embedding", dimensions: 2 };
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

    // ⛔ 委譲先が非決定的でも、返る応答は揺れない。
    expect(first.content).toBe("応答#1");
    expect(second.content).toBe("応答#1");
    expect(third.content).toBe("応答#1");
    // ⭐ 実 API は1回しか叩かれない（繰り返し分の課金が消える）。
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

    // 1回の記録の中で同じプロンプトが3回現れる状況（`answer` の評価ケース12件のうち
    // 3件が同じフィラー発話を含む、という実際の形）。
    const live = [
      (await recording.complete(ctx, prompt)).content,
      (await recording.complete(ctx, prompt)).content,
      (await recording.complete(ctx, prompt)).content,
    ];

    // カセットに残る唯一の値が、実行中に返した値すべてと一致する。
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
    // 入力の件数・順序はそのまま返す（委譲先の契約を壊さない）。
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[1]);
  });
});
