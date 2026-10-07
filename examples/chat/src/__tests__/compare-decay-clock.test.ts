import type { MemoryStore, Runtime, TenantSettingsStore } from "@mnemora/core";
import { describe, expect, it, vi } from "vitest";
import { runComparison } from "../compare.js";

function buildFakeRuntime(): Runtime {
  let nextObserveId = 0;
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
  return { observe, tick, recall } as unknown as Runtime;
}

function buildFakeMemoryStore(): MemoryStore {
  return {} as unknown as MemoryStore;
}

describe("runComparison: --decay-clock の有無で writeDecayClock の呼び出しが変わる(ADR 0165 決めたこと11)", () => {
  it("decayClock を渡さなければ setDecayClock は一度も呼ばれない(既定 'wall' を1バイトも変えない)", async () => {
    const setDecayClock = vi.fn();

    const rows = await runComparison(buildFakeRuntime(), {
      fillerPairsSequence: [0, 1],
      memoryStore: buildFakeMemoryStore(),
    });

    expect(rows).toHaveLength(2);
    expect(setDecayClock).not.toHaveBeenCalled();
  });

  it("decayClock を渡すと、生成した各テナントに1回ずつ書き込まれる", async () => {
    const setDecayClock = vi.fn(async () => {});
    const tenantSettingsStore = { setDecayClock } as unknown as TenantSettingsStore;

    const rows = await runComparison(buildFakeRuntime(), {
      fillerPairsSequence: [0, 1],
      memoryStore: buildFakeMemoryStore(),
      decayClock: { store: tenantSettingsStore, clock: "activity" },
    });

    expect(rows).toHaveLength(2);
    expect(setDecayClock).toHaveBeenCalledTimes(2);
    expect(setDecayClock).toHaveBeenNthCalledWith(1, { tenantId: "example-compare-0" }, "activity");
    expect(setDecayClock).toHaveBeenNthCalledWith(2, { tenantId: "example-compare-1" }, "activity");
  });
});
