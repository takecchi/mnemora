import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  buildNewMemoryFromCandidate,
  extractCandidates,
  resolveDigest,
  type ExtractedMemoryCandidate,
} from "../extraction.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Observation } from "../observation.js";
import { defaultDecayStrategy } from "../strategies/decay.js";

/**
 * 抽出の後処理（`extraction.ts`）に変異を当てて、生き残った形を塞ぐ歯。
 * どの歯も、既存の試験の入力が片側に偏っていて見分けられなかった値を足している。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

const observation: Observation = {
  id: "obs-1",
  tenantId: "tenant-1",
  subjectId: "alice",
  externalId: null,
  kind: "utterance",
  payload: { text: "来週の月曜に歯医者の予約がある" },
  occurredAt: null,
  recordedAt: new Date("2026-01-01T00:00:00.000Z"),
} as Observation;

function llmReturning(memories: ExtractedMemoryCandidate[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories }) as T,
  };
}

function llmThrowing(error: unknown): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async () => {
      throw error;
    },
  };
}

describe("resolveDigest — 空かどうかの境界は trim 後の長さ 0 と 1 の間", () => {
  it.each([
    ["1文字（境界ちょうど）", "a", { digest: "a", digestSource: "llm" }],
    ["trim 後に1文字", " 要 ", { digest: "要", digestSource: "llm" }],
    ["trim 後に0文字（1つ外側）", " ", { digest: "本文", digestSource: "fallback" }],
  ])("%s", (_, digest, expected) => {
    expect(resolveDigest({ content: "本文", digest }, 200)).toEqual(expected);
  });
});

describe("extractCandidates — 空白だけの本文は、何件目にあっても全体を倒す", () => {
  it.each([
    ["先頭", ["　", "歯医者の予約は月曜", "受付は9時から"]],
    ["真ん中", ["歯医者の予約は月曜", "　", "受付は9時から"]],
    ["末尾", ["歯医者の予約は月曜", "受付は9時から", "　"]],
  ])("空白だけの本文が%sにある", async (_, contents) => {
    const result = await extractCandidates(
      llmReturning(contents.map((content) => ({ content, provenanceKind: "stated" }))),
      ctx,
      observation,
    );
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.candidates.map((c) => c.content)).toEqual(["来週の月曜に歯医者の予約がある"]);
  });

  it("陽性対照: 空白だけの本文が無ければ倒れない", async () => {
    const result = await extractCandidates(
      llmReturning([
        { content: "歯医者の予約は月曜", provenanceKind: "stated" },
        { content: "受付は9時から", provenanceKind: "stated" },
      ]),
      ctx,
      observation,
    );
    expect(result.usedWholeObservationFallback).toBe(false);
    expect(result.candidates).toHaveLength(2);
  });
});

describe("extractCandidates — 投げ直すかは signal で決め、例外の名前では決めない（ADR 0359 決めたこと4）", () => {
  const abortNamed = new DOMException("provider aborted on its own", "AbortError");

  it.each([
    ["signal を渡さない", undefined],
    ["abort されていない signal を渡す", new AbortController().signal],
  ])(
    "%s呼び出しで provider が AbortError を投げたら、全文フォールバックへ倒す",
    async (_, signal) => {
      const result = await extractCandidates(
        llmThrowing(abortNamed),
        ctx,
        observation,
        undefined,
        signal,
      );
      expect(result.usedWholeObservationFallback).toBe(true);
      expect(result.failure).toEqual({ kind: null, message: "provider aborted on its own" });
    },
  );

  it("陽性対照: abort 済みの signal なら投げ直す", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractCandidates(llmThrowing(abortNamed), ctx, observation, undefined, controller.signal),
    ).rejects.toBeDefined();
  });
});

describe("rejectedSubjectIds — 弾いた順に並ぶ（逆順・回文で見分けられない並びを避ける）", () => {
  it("異なる3つの値を、弾いた順のまま返す", async () => {
    const result = await extractCandidates(
      llmReturning([
        { content: "一つ目", provenanceKind: "stated", subjectId: "user:x" },
        { content: "一覧内", provenanceKind: "stated", subjectId: "user:a" },
        { content: "二つ目", provenanceKind: "stated", subjectId: "user:y" },
        { content: "三つ目", provenanceKind: "stated", subjectId: "user:z" },
      ]),
      ctx,
      observation,
      ["user:a"],
    );
    expect(result.rejectedSubjectIds).toEqual(["user:x", "user:y", "user:z"]);
  });
});

describe("buildNewMemoryFromCandidate", () => {
  const baseParams = {
    ctx,
    observation,
    hashContent: (content: string) => `hash(${content})`,
    extractorVersion: "v1",
    llmModelId: "test-model",
    promptVersion: "prompt-v1",
    halfLifeHours: 720,
    now: new Date("2026-02-01T00:00:00.000Z"),
    digestFallbackLength: 200,
  };

  describe("inferred の confidence は省略のときだけ 0.5（0 は省略ではない）", () => {
    it.each([
      ["0（境界ちょうど）", 0, 0],
      ["0.01（1つ外側）", 0.01, 0.01],
      ["省略", undefined, 0.5],
    ])("%s", (_, confidence, expected) => {
      const memory = buildNewMemoryFromCandidate({
        ...baseParams,
        candidate: {
          content: "推論した内容",
          provenanceKind: "inferred",
          ...(confidence !== undefined ? { confidence } : {}),
        },
      });
      expect(memory.provenance.kind === "inferred" && memory.provenance.confidence).toBe(expected);
    });
  });

  it("recordedAt と減衰の起点は now であり、observation の recordedAt ではない", () => {
    // runtime の observe は observation の recordedAt と now に同じ時刻を使うので、別の値はここでしか作れない。
    expect(baseParams.now.getTime()).not.toBe(observation.recordedAt.getTime());
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      candidate: { content: "本文", provenanceKind: "stated" },
    });
    const floorFrom = (recordedAt: Date) =>
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: baseParams.halfLifeHours,
      });
    expect(memory.recordedAt).toEqual(baseParams.now);
    expect(memory.decayFloorAt).toEqual(floorFrom(baseParams.now));
    expect(memory.decayFloorAt).not.toEqual(floorFrom(observation.recordedAt));
  });
});
