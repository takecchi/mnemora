import type { RecallRecord } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import { formatRecallExplainDemo, type RecallExplainDemoResult } from "../recall-explain.js";

/**
 * `explain` の digest は `RecallRecordMemory` からではなく `memoryStore.get` で別に引く（README「出力の読み方」3）。
 * 引けなかった記憶を、空の digest として黙って出さないこと（「無い」を名指しする）。
 */

function recordWith(memoryIds: string[]): RecallRecord {
  return {
    recallId: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-1",
    subjectId: null,
    query: { text: "好きな食べ物と趣味は何ですか?" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: memoryIds.length, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: {
      breakdownCaptured: true,
      memories: memoryIds.map((memoryId) => ({
        memoryId,
        retrievedVia: "ann" as const,
        score: {
          similarity: 0.9,
          lexicalMatch: 0.5,
          decay: 0.8,
          tagMatch: 1,
          freshness: 0.7,
          strength: 1,
          total: 0.6,
        },
      })),
    },
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  };
}

function demoResult(digestByMemoryId: Record<string, string>): RecallExplainDemoResult {
  return {
    tenantId: "tenant-1",
    recallId: "11111111-1111-4111-8111-111111111111",
    recallResultMemoryIds: [],
    record: recordWith(["memory-found", "memory-missing"]),
    missingRecallId: "22222222-2222-4222-8222-222222222222",
    missingRecord: null,
    digestByMemoryId,
  };
}

describe("formatRecallExplainDemo —— 引けなかった digest を空にしない", () => {
  it("digest を引けた記憶は digest を出し、引けなかった記憶は空の digest で出さない", () => {
    const text = formatRecallExplainDemo(
      demoResult({ "memory-found": "好きな食べ物はカレーです。" }),
    );
    expect(text).toContain("好きな食べ物はカレーです。");
    expect(text).toContain("memory-missing");
    expect(text).not.toContain('digest=""');
  });
});
