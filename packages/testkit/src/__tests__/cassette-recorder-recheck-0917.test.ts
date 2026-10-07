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
 * Issue #1812（09/17 マージ分の確かめ直し）まとまり G5: PR #514（ADR 0233）の
 * `cassette-recorder.ts` の確かめ直しで、既存の試験をすり抜けた変異に足した歯。
 * 約束の出所は、各 `it` の頭に ADR・doc の名前で書く。
 */

const ctx: Ctx = { tenantId: "cassette-recorder-recheck-0917" };
const space: EmbeddingSpaceId = { provider: "openai", model: "fake-embedding", dimensions: 2 };
const prompt: PromptSpec = { system: "s", messages: [{ role: "user", content: "q" }] };

describe("CassetteRecorder: 同じ鍵を二度記録すると後の値で上書きする（recordLLM / recordEmbedding の doc）", () => {
  it("recordLLM: 同じ prompt の2回目の値が残る", () => {
    const recorder = new CassetteRecorder();
    recorder.recordEmbedding(space, "あ", [1, 1]);
    recorder.recordLLM("m", prompt, { content: "1回目" });
    recorder.recordLLM("m", prompt, { content: "2回目" });
    expect(recorder.llmCount).toBe(1);
    expect(recorder.lookupLLM(prompt)?.value).toEqual({ content: "2回目" });
    expect(Object.values(recorder.toCassette().llm.entries).map((e) => e.value)).toEqual([
      { content: "2回目" },
    ]);
  });

  it("recordEmbedding: 同じ text の2回目のベクトルが残る", () => {
    const recorder = new CassetteRecorder();
    recorder.recordEmbedding(space, "あ", [1, 1]);
    recorder.recordEmbedding(space, "あ", [2, 2]);
    expect(recorder.embeddingCount).toBe(1);
    expect(recorder.lookupEmbedding("あ")?.vector).toEqual([2, 2]);
  });
});

describe("CassetteRecorder.toCassette: recordedAt は渡した時刻（省略時は今）", () => {
  const filled = (): CassetteRecorder => {
    const recorder = new CassetteRecorder();
    recorder.recordEmbedding(space, "あ", [1, 1]);
    recorder.recordLLM("m", prompt, { content: "x" });
    return recorder;
  };

  it("now を渡せば、その時刻が recordedAt になる", () => {
    const now = new Date("2026-09-17T01:02:03.000Z");
    expect(filled().toCassette(now).recordedAt).toBe("2026-09-17T01:02:03.000Z");
  });

  it("now を省略すれば、呼んだ時点の時刻になる", () => {
    const before = Date.now();
    const at = Date.parse(filled().toCassette().recordedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe("RecordingEmbeddingProvider: 約束違反の戻りは記録せずに落とす（ADR 0452）", () => {
  const providerReturning = (vectors: unknown): EmbeddingProvider => ({
    space,
    embed: async () => vectors as number[][],
  });

  it("配列でないベクトル（長さも成分も合う Float32Array）は記録せずに落とす", async () => {
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(
      providerReturning([Float32Array.from([1, 2])]),
      recorder,
    );
    await expect(recording.embed(ctx, ["あ"])).rejects.toThrow(/ベクトル（配列）を返さなかった/);
    expect(recorder.embeddingCount).toBe(0);
  });

  it("入力より多い件数を返したら、記録せずに落とす（件数が違う戻りも約束違反）", async () => {
    const recorder = new CassetteRecorder();
    const recording = new RecordingEmbeddingProvider(
      providerReturning([
        [1, 1],
        [2, 2],
      ]),
      recorder,
    );
    await expect(recording.embed(ctx, ["あ"])).rejects.toThrow(/違う件数を返した/);
    expect(recorder.embeddingCount).toBe(0);
  });
});

describe("RecordingLLMProvider: delegate が返した後に自分の戻りを書き換えても、記録は動かない（ADR 0500 の追記）", () => {
  it("complete: delegate が保持する応答を後から書き換えても、記録は最初の値のまま", async () => {
    const held: LLMResponse = { content: "最初" };
    const delegate: LLMProvider = {
      complete: async () => held,
      completeStructured: async () => {
        throw new Error("使わない");
      },
    };
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "m");
    await recording.complete(ctx, prompt);
    held.content = "後から書き換えた";
    expect(recorder.lookupLLM(prompt)?.value).toEqual({ content: "最初" });
    expect((await recording.complete(ctx, prompt)).content).toBe("最初");
  });

  it("completeStructured: delegate が保持する値を後から書き換えても、記録は最初の値のまま", async () => {
    const held = { digest: "最初" };
    const delegate: LLMProvider = {
      complete: async () => {
        throw new Error("使わない");
      },
      completeStructured: async <T>(): Promise<T> => held as T,
    };
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "m");
    const schema = z.object({ digest: z.string() });
    await recording.completeStructured(ctx, { prompt, schema });
    held.digest = "後から書き換えた";
    expect(recorder.lookupLLM(prompt)?.value).toEqual({ digest: "最初" });
  });
});

describe("RecordingLLMProvider.completeStructured: 記録済みの値も呼び出し側の schema で検証し直す（コードの doc・RecordedLLMProvider と同じ規律）", () => {
  it("1回目は緩い schema で記録し、2回目の厳しい schema に合わない値は拒む", async () => {
    let calls = 0;
    const delegate: LLMProvider = {
      complete: async () => {
        throw new Error("使わない");
      },
      completeStructured: async <T>(): Promise<T> => {
        calls += 1;
        return { digest: "要旨" } as T;
      },
    };
    const recording = new RecordingLLMProvider(delegate, new CassetteRecorder(), "m");
    const loose = z.object({ digest: z.string() });
    const strict = z.object({ digest: z.string(), extra: z.number() });
    await recording.completeStructured(ctx, { prompt, schema: loose });
    await expect(recording.completeStructured(ctx, { prompt, schema: strict })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("RecordingLLMProvider.completeStructured: 失敗した呼び出しは memo に残さない（ADR 0452）", () => {
  it("1回目が失敗しても、2回目は delegate を呼び直して成功する", async () => {
    let calls = 0;
    const delegate: LLMProvider = {
      complete: async () => {
        throw new Error("使わない");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        calls += 1;
        if (calls === 1) throw new Error("一時的な失敗");
        return req.schema.parse({ digest: "要旨" });
      },
    };
    const recorder = new CassetteRecorder();
    const recording = new RecordingLLMProvider(delegate, recorder, "m");
    const schema = z.object({ digest: z.string() });
    await expect(recording.completeStructured(ctx, { prompt, schema })).rejects.toThrow(
      "一時的な失敗",
    );
    expect(recorder.llmCount).toBe(0);
    await expect(recording.completeStructured(ctx, { prompt, schema })).resolves.toEqual({
      digest: "要旨",
    });
    expect(calls).toBe(2);
  });
});
