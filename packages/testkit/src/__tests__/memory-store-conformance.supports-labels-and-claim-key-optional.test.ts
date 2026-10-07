import { describe, expect, it } from "vitest";
import type { MemoryStore } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { describeMemoryStoreConformance } from "../memory-store-conformance.js";
import type { MemoryStoreConformanceOptions } from "../memory-store-conformance.js";

interface LabelClaimKeyCounts {
  listLabels: number;
  registerLabel: number;
  findActiveByClaimKey: number;
}

function memoryStoreHarness(hideMethods = false): {
  createStore: () => MemoryStore;
  listEventsForMemory: MemoryStoreConformanceOptions["listEventsForMemory"];
  prepareRecallId: MemoryStoreConformanceOptions["prepareRecallId"];
  claimEmbedJobs: MemoryStoreConformanceOptions["claimEmbedJobs"];
  listPurgedEvents: MemoryStoreConformanceOptions["listPurgedEvents"];
  counts: () => LabelClaimKeyCounts;
  reads: () => LabelClaimKeyCounts;
} {
  let latest: InMemoryMemoryStore | undefined;
  const counts: LabelClaimKeyCounts = { listLabels: 0, registerLabel: 0, findActiveByClaimKey: 0 };
  const reads: LabelClaimKeyCounts = { listLabels: 0, registerLabel: 0, findActiveByClaimKey: 0 };
  const countedMethods = new Set<keyof LabelClaimKeyCounts>([
    "listLabels",
    "registerLabel",
    "findActiveByClaimKey",
  ]);

  const createStore = (): MemoryStore => {
    const inner = new InMemoryMemoryStore();
    latest = inner;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && countedMethods.has(prop as keyof LabelClaimKeyCounts)) {
          reads[prop as keyof LabelClaimKeyCounts] += 1;
          if (hideMethods) {
            return undefined;
          }
          const original = Reflect.get(target, prop, receiver) as
            ((...args: unknown[]) => unknown) | undefined;
          if (!original) {
            return original;
          }
          return (...args: unknown[]) => {
            counts[prop as keyof LabelClaimKeyCounts] += 1;
            return original.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryStore;
  };

  return {
    createStore,
    listEventsForMemory: (ctx, memoryId) => {
      if (!latest) {
        throw new Error("listEventsForMemory より先に createStore() を呼ぶ必要がある");
      }
      return latest.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.memoryId === memoryId,
      );
    },
    prepareRecallId: async (ctx) => {
      if (!latest) {
        throw new Error("prepareRecallId より先に createStore() を呼ぶ必要がある");
      }
      return latest.createRecall(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        query: { text: "fixture" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
      });
    },
    claimEmbedJobs: (ctx, now) => {
      if (!latest) {
        throw new Error("claimEmbedJobs より先に createStore() を呼ぶ必要がある");
      }
      return new InMemoryOutboxStore(latest.outboxJobs).claimBatch(ctx, {
        kinds: ["embed"],
        limit: 100,
        now,
        claimedBy: "conformance-requeue",
        leaseMs: 60_000,
      });
    },
    listPurgedEvents: (ctx) => {
      if (!latest) {
        throw new Error("listPurgedEvents より先に createStore() を呼ぶ必要がある");
      }
      return latest.events.filter(
        (event) => event.tenantId === ctx.tenantId && event.kind === "events_purged",
      );
    },
    counts: () => ({ ...counts }),
    reads: () => ({ ...reads }),
  };
}

const control = memoryStoreHarness();
describeMemoryStoreConformance({
  name: "labels/findActiveByClaimKey probe (control, both true)",
  createStore: control.createStore,
  listEventsForMemory: control.listEventsForMemory,
  prepareRecallId: control.prepareRecallId,
  claimEmbedJobs: control.claimEmbedJobs,
  supportsSupersedeWithNewMemories: true,
  supportsPurgeExpiredEvents: true,
  listPurgedEvents: control.listPurgedEvents,
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsOnlyMemoryIdsFilter: true,
  supportsLabels: true,
  supportsFindActiveByClaimKey: true,
  supportsListActiveClaimPredicates: true,
  supportsEraseTenant: true,
});

const omitted = memoryStoreHarness();
describeMemoryStoreConformance({
  name: "labels/findActiveByClaimKey probe (v1.0.0 call shape, both omitted)",
  createStore: omitted.createStore,
  listEventsForMemory: omitted.listEventsForMemory,
  prepareRecallId: omitted.prepareRecallId,
  claimEmbedJobs: omitted.claimEmbedJobs,
  supportsSupersedeWithNewMemories: true,
  supportsPurgeExpiredEvents: true,
  listPurgedEvents: omitted.listPurgedEvents,
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsOnlyMemoryIdsFilter: true,
  supportsListActiveClaimPredicates: true,
  supportsEraseTenant: true,
  // supportsLabels / supportsFindActiveByClaimKey は意図的に渡さない（v1.0.0 の呼び出し形そのもの）。
});

const notImplemented = memoryStoreHarness(true);
describeMemoryStoreConformance({
  name: "labels/findActiveByClaimKey probe (both false, methods not implemented)",
  createStore: notImplemented.createStore,
  listEventsForMemory: notImplemented.listEventsForMemory,
  prepareRecallId: notImplemented.prepareRecallId,
  claimEmbedJobs: notImplemented.claimEmbedJobs,
  supportsSupersedeWithNewMemories: true,
  supportsPurgeExpiredEvents: true,
  listPurgedEvents: notImplemented.listPurgedEvents,
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsOnlyMemoryIdsFilter: true,
  supportsLabels: false,
  supportsFindActiveByClaimKey: false,
  supportsListActiveClaimPredicates: true,
  supportsEraseTenant: true,
});

describe("supportsLabels/supportsFindActiveByClaimKey を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、該当する適合項目を実行しない", () => {
  it("陽性対照: 両方とも true では listLabels/registerLabel/findActiveByClaimKey が実際に呼ばれている", () => {
    const { listLabels, registerLabel, findActiveByClaimKey } = control.counts();
    expect(listLabels).toBeGreaterThan(0);
    expect(registerLabel).toBeGreaterThan(0);
    expect(findActiveByClaimKey).toBeGreaterThan(0);
  });

  it("両方を省略すると、listLabels/registerLabel/findActiveByClaimKey は一度も呼ばれない", () => {
    const { listLabels, registerLabel, findActiveByClaimKey } = omitted.counts();
    expect(listLabels).toBe(0);
    expect(registerLabel).toBe(0);
    expect(findActiveByClaimKey).toBe(0);
  });

  it("false: listLabels/registerLabel/findActiveByClaimKey は一度も呼ばれず、「実装していない」ことの assert がそれぞれの有無を読みに行く", () => {
    const { listLabels, registerLabel, findActiveByClaimKey } = notImplemented.counts();
    expect(listLabels).toBe(0);
    expect(registerLabel).toBe(0);
    expect(findActiveByClaimKey).toBe(0);
    const reads = notImplemented.reads();
    expect(reads.listLabels).toBeGreaterThan(0);
    expect(reads.registerLabel).toBeGreaterThan(0);
    expect(reads.findActiveByClaimKey).toBeGreaterThan(0);
  });
});
