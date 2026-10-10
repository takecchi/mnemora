import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { buildNewMemoryFromCandidate } from "../extraction.js";
import type { Memory } from "../memory.js";
import type { Observation } from "../observation.js";
import { buildConsolidatedMemory } from "../strategies/consolidate.js";
import { buildReflectedMemory } from "../strategies/reflect.js";

const ctx: Ctx = { tenantId: "llm-blank-tags" };
const NOW = new Date("2026-09-27T00:00:00.000Z");
const BLANK_AND_REAL = ["", " ", "\u3000", "\n\t", "旅行", "旅行"];

const observation: Observation = {
  id: "obs-1",
  tenantId: ctx.tenantId,
  subjectId: null,
  externalId: null,
  kind: "utterance",
  payload: { text: "発話" },
  occurredAt: null,
  recordedAt: NOW,
};

function eligible(id: string, tags: string[]): Memory {
  return {
    id,
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${id}`,
    contentHash: `hash-${id}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    status: "active",
    supersededById: null,
    contestedWithId: null,
    tags,
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: NOW,
    embeddingStatus: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const common = {
  ctx,
  hashContent: (content: string) => `hash(${content})`,
  digestFallbackLength: 200,
  halfLifeHours: 24,
  now: NOW,
};

describe("LLM が返した tags の空文字・空白だけの要素は捨てる", () => {
  it("抽出（buildNewMemoryFromCandidate）: 空白だけの要素を捨て、ほかの要素と並びはそのまま", () => {
    const memory = buildNewMemoryFromCandidate({
      ...common,
      observation,
      candidate: { content: "本文", provenanceKind: "stated", tags: BLANK_AND_REAL },
      extractorVersion: "v1",
      llmModelId: "model",
      promptVersion: "p1",
    });
    expect(memory.tags).toEqual(["旅行", "旅行"]);
  });

  it("抽出: 全部が空白だけなら空配列（tags を返さなかったのと同じ）", () => {
    const memory = buildNewMemoryFromCandidate({
      ...common,
      observation,
      candidate: { content: "本文", provenanceKind: "stated", tags: ["", " "] },
      extractorVersion: "v1",
      llmModelId: "model",
      promptVersion: "p1",
    });
    expect(memory.tags).toEqual([]);
  });

  it("統合（buildConsolidatedMemory）: LLM の tags の空白だけの要素を捨てる", () => {
    const memory = buildConsolidatedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { content: "統合", tags: BLANK_AND_REAL },
    });
    expect(memory.tags).toEqual(["旅行", "旅行"]);
  });

  it("統合: LLM の tags が全部空白だけなら、LLM が tags: [] を返したのと同じ空配列", () => {
    const memory = buildConsolidatedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { content: "統合", tags: ["", " "] },
    });
    expect(memory.tags).toEqual([]);
  });

  it("内省: LLM の tags が全部空白だけなら、LLM が tags: [] を返したのと同じ空配列（統合元の和集合へ倒れない）", () => {
    const memory = buildReflectedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { outcome: "reflected", content: "内省", tags: ["", " "] },
    });
    expect(memory.tags).toEqual([]);
  });

  it("統合: LLM が tags: [] を返したら、統合元にタグがあっても空配列（和集合へ倒れない）", () => {
    const memory = buildConsolidatedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { content: "統合", tags: [] },
    });
    expect(memory.tags).toEqual([]);
  });

  it("内省: LLM が tags: [] を返したら、統合元にタグがあっても空配列（和集合へ倒れない）", () => {
    const memory = buildReflectedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { outcome: "reflected", content: "内省", tags: [] },
    });
    expect(memory.tags).toEqual([]);
  });

  it("1字の要素も、空白でなければ捨てない（抽出）", () => {
    const extracted = buildNewMemoryFromCandidate({
      ...common,
      observation,
      candidate: { content: "本文", provenanceKind: "stated", tags: ["旅", " ", "a"] },
      extractorVersion: "v1",
      llmModelId: "model",
      promptVersion: "p1",
    });
    expect(extracted.tags).toEqual(["旅", "a"]);
  });

  it("空白でない要素は、前後の空白を削らず、そのまま残す（抽出・統合・内省）", () => {
    const tags = [" ", " 旅行 ", "\n出張\t", ""];
    const extracted = buildNewMemoryFromCandidate({
      ...common,
      observation,
      candidate: { content: "本文", provenanceKind: "stated", tags },
      extractorVersion: "v1",
      llmModelId: "model",
      promptVersion: "p1",
    });
    expect(extracted.tags).toEqual([" 旅行 ", "\n出張\t"]);
    const consolidated = buildConsolidatedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { content: "統合", tags },
    });
    expect(consolidated.tags).toEqual([" 旅行 ", "\n出張\t"]);
    const reflected = buildReflectedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { outcome: "reflected", content: "内省", tags },
    });
    expect(reflected.tags).toEqual([" 旅行 ", "\n出張\t"]);
  });

  it("LLM が tags を返さなかったときの統合元の和集合には、捨てる処理を当てない（統合・内省）", () => {
    // 統合元に、すでに書かれている空白だけの tag を持たせる。和集合はそのまま引き継ぐ。
    const eligibleMemories = [eligible("a", [" ", "x"]), eligible("b", ["y", "x"])];
    const consolidated = buildConsolidatedMemory({
      ...common,
      eligible: eligibleMemories,
      llmResult: { content: "統合" },
    });
    expect(consolidated.tags).toEqual([" ", "x", "y"]);
    const reflected = buildReflectedMemory({
      ...common,
      eligible: eligibleMemories,
      llmResult: { outcome: "reflected", content: "内省" },
    });
    expect(reflected.tags).toEqual([" ", "x", "y"]);
  });

  it("内省（buildReflectedMemory）: スキーマを通る空白だけの要素を捨てる", () => {
    const memory = buildReflectedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { outcome: "reflected", content: "内省", tags: [" ", "\u3000", "旅行"] },
    });
    expect(memory.tags).toEqual(["旅行"]);
  });
});
