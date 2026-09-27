import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { buildNewMemoryFromCandidate } from "../extraction.js";
import type { Memory } from "../memory.js";
import type { Observation } from "../observation.js";
import { buildConsolidatedMemory } from "../strategies/consolidate.js";
import { buildReflectedMemory } from "../strategies/reflect.js";

/**
 * LLM が返した tags のうち、空文字・空白だけの要素は「tag を返さなかった」ものとして捨てる。
 *
 * tags は「話題・内容の要約」を LLM が推論した値（ADR 0318 の3本の役割分担の表）であり、
 * 空白だけの要素は要約になっていない。LLM 由来の空白だけの文字列を「与えられなかった」として
 * 扱うのは、digest（`resolveDigest`、空白だけならフォールバック）と claim key
 * （`deriveClaimKeys`、空白だけなら `null`）と同じ扱いである。
 *
 * 【実測 2026-09-27】以前は `""`・`" "`・全角空白（U+3000） をそのまま `Memory.tags` に書き、
 * `@mnemora/postgres` と testkit の `InMemoryMemoryStore` の両方で、その名前の proposed ラベルが
 * `listLabels` に出ていた（extract の inline / deferred・consolidate・reflect の全経路。
 * reflect は `""` をスキーマで拒むが `" "` は通していた）。通しの歯は
 * `packages/postgres/src/__tests__/llm-blank-tags.postgres.test.ts`。
 */

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

  it("内省（buildReflectedMemory）: スキーマを通る空白だけの要素を捨てる", () => {
    const memory = buildReflectedMemory({
      ...common,
      eligible: [eligible("a", ["x"]), eligible("b", ["y"])],
      llmResult: { outcome: "reflected", content: "内省", tags: [" ", "\u3000", "旅行"] },
    });
    expect(memory.tags).toEqual(["旅行"]);
  });
});
