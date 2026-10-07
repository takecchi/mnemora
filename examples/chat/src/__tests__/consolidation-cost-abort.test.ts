import type { EmbeddingProvider, Memory, MemoryStore, Runtime } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import { describe, expect, it } from "vitest";
import { exitCodeForConsolidationCostRun } from "../consolidation-json.js";
import { formatConsolidationCostReport } from "../consolidation-cost-format.js";
import { runConsolidationCost } from "../consolidation-cost.js";

const INJECTED_TOP_MESSAGE = "e2e-injected-pg-message-5t8w-top";
const INJECTED_MID_MESSAGE = "e2e-injected-pg-message-5t8w-mid";
const INJECTED_INNER_MESSAGE = "e2e-injected-pg-message-5t8w-inner";
const INJECTED_SQL_STATE = "23503";

function buildInjectedError(): Error {
  const inner = Object.assign(new Error(INJECTED_INNER_MESSAGE), { code: INJECTED_SQL_STATE });
  const mid = new Error(INJECTED_MID_MESSAGE, { cause: inner });
  const top = new Error(INJECTED_TOP_MESSAGE, { cause: mid });
  return top;
}

function fakeMemory(id: string): Memory {
  return {
    id,
    tenantId: "t",
    content: `content-${id}`,
    contentHash: `hash-${id}`,
    digest: `digest-${id}`,
    digestSource: "fallback",
    provenance: { kind: "stated" },
    status: "active",
    tags: [],
    recordedAt: new Date(0),
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: new Date(0),
    embeddingStatus: "ready",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as Memory;
}

function buildFakeRuntime(): Runtime {
  let nextObserveId = 0;
  let nextConsolidatedId = 0;

  let pendingEmbedJobs = 0;

  const observe: Runtime["observe"] = async () => {
    nextObserveId += 1;
    pendingEmbedJobs += 1;
    return {
      observationId: `obs-${nextObserveId}`,
      memoryIds: [`mem-observe-${nextObserveId}`],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };

  const tick: Runtime["tick"] = async () => {
    const processed = pendingEmbedJobs;
    pendingEmbedJobs = 0;
    return { processed, failed: 0, unsupported: [] } as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;
  };

  const recall: Runtime["recall"] = async () =>
    ({
      recallId: "recall-1",
      memories: [],
      omitted: [],
      index: { groups: [], totalInScope: 0, countKind: "exact" },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      explain: { stages: [] },
    }) as unknown as Awaited<ReturnType<Runtime["recall"]>>;

  const consolidate: Runtime["consolidate"] = async (_ctx, opts) => {
    const reason = opts.reason ?? "";
    const match = /round (\d+)/.exec(reason);
    const round = match ? Number(match[1]) : -1;
    if (round === 2) {
      throw buildInjectedError();
    }
    nextConsolidatedId += 1;
    pendingEmbedJobs += 1;
    return {
      outcome: "consolidated",
      atomicity: "store_supported",
      nothingReason: null,
      consolidatedMemoryId: `mem-consolidated-${nextConsolidatedId}`,
      sources: [],
      llmCalls: 1,
      llmFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["consolidate"]>>;
  };

  return {
    observe,
    tick,
    recall,
    consolidate,
  } as unknown as Runtime;
}

function buildFakeMemoryStore(): MemoryStore {
  const getMany: MemoryStore["getMany"] = async (_ctx, ids) => ids.map((id) => fakeMemory(id));
  return { getMany } as unknown as MemoryStore;
}

function buildFakeEmbeddingProvider(): EmbeddingProvider {
  return {
    space: { provider: "fake", model: "fake-model", dimensions: 4 },
  } as unknown as EmbeddingProvider;
}

describe("runConsolidationCost: round の途中の例外を受け止める(e2e、偽物注入)", () => {
  it("round 2 で例外を投げても、round 0・1 の結果を捨てず、exitCode/abort が正しい", async () => {
    const runtime = buildFakeRuntime();
    const memoryStore = buildFakeMemoryStore();
    const embeddingProvider = buildFakeEmbeddingProvider();
    const pool = {} as unknown as PostgresClient["pool"];

    const json = await runConsolidationCost({
      runtime,
      memoryStore,
      embeddingProvider,
      pool,
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      tenantId: "consolidation-cost-abort-e2e",
      groupSize: 2,
      budgetLadder: [],
      recallLimit: 10,
      measuredAt: new Date(0),
      commit: null,
      haystackSize: 4,
    });

    expect(exitCodeForConsolidationCostRun(json)).toBe(1);
    expect(json.stopReason).toBe("aborted_on_error");

    expect(json.rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(json.stoppedAfterRound).toBe(1);

    const report = formatConsolidationCostReport(json);
    expect(report).toContain("| 0 |");
    expect(report).toContain("| 1 |");

    expect(json.abort).not.toBeNull();
    expect(json.abort?.round).toBe(2);
    expect(json.abort?.sqlState).toBe(INJECTED_SQL_STATE);
    expect(json.abort?.causeChain).toContain(INJECTED_TOP_MESSAGE);
    expect(json.abort?.causeChain).toContain(INJECTED_MID_MESSAGE);
    expect(json.abort?.causeChain).toContain(INJECTED_INNER_MESSAGE);
  });
});
