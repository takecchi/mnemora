import { describe, expect, it } from "vitest";
import {
  assertValidEventRetentionDays,
  assertWellFormedCtx,
  DEFAULT_HALF_LIFE_HOURS,
  isHalfLifeHoursInRange,
  type Ctx,
  type EventRetention,
  type EventRetentionSetting,
  type TenantSettingsStore,
} from "@mnemora/core";
import type { RunnerTask } from "vitest";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";
import { describeOutboxStoreConformance } from "../outbox-store-conformance.js";
import { describeVectorStoreConformance } from "../vector-store-conformance.js";
import { buildNewMemoryFixture, buildProvenanceFixture } from "../test-data.js";
import { describeMemoryStoreConformance } from "../memory-store-conformance.js";
import { describeTenantSettingsStoreConformance } from "../tenant-settings-store-conformance.js";

const MEMORY_NAME = "omitted optional flags (memory)";
let latest: InMemoryMemoryStore | undefined;
const current = (): InMemoryMemoryStore => {
  if (!latest) throw new Error("createStore() より先に呼ばれた");
  return latest;
};

describeMemoryStoreConformance({
  name: MEMORY_NAME,
  createStore: () => {
    latest = new InMemoryMemoryStore();
    return latest;
  },
  listEventsForMemory: (ctx, memoryId) =>
    current().events.filter((e) => e.tenantId === ctx.tenantId && e.memoryId === memoryId),
  prepareRecallId: async (ctx) =>
    current().createRecall(ctx, {
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
    }),
  claimEmbedJobs: (ctx, now) =>
    new InMemoryOutboxStore(current().outboxJobs).claimBatch(ctx, {
      kinds: ["embed"],
      limit: 100,
      now,
      claimedBy: "conformance-omitted-flags",
      leaseMs: 60_000,
    }),
  supportsSupersedeWithNewMemories: true,
  supportsPurgeExpiredEvents: true,
  listPurgedEvents: (ctx) =>
    current().events.filter((e) => e.tenantId === ctx.tenantId && e.kind === "events_purged"),
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsEraseTenant: true,
  // 任意のフラグは意図的に渡さない（渡すと「未検査」の it が登録されない）。
});

class MinimalTenantSettingsStore implements TenantSettingsStore {
  private readonly retention = new Map<string, EventRetentionSetting>();
  private readonly halfLifeHours = new Map<string, number>();
  setDefaultHalfLifeHours(ctx: Ctx, hours: number): void {
    if (!isHalfLifeHoursInRange(hours)) throw new Error(`half life hours out of range: ${hours}`);
    this.halfLifeHours.set(ctx.tenantId, hours);
  }
  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    return this.halfLifeHours.get(ctx.tenantId) ?? DEFAULT_HALF_LIFE_HOURS;
  }
  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    assertWellFormedCtx(ctx);
    const retention = this.retention.get(ctx.tenantId);
    if (retention) return retention;
    return this.halfLifeHours.has(ctx.tenantId) ? { kind: "unlimited" } : { kind: "unset" };
  }
  async setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    if (retention.kind === "days") assertValidEventRetentionDays(retention.days);
    this.retention.set(ctx.tenantId, retention);
  }
}

const TENANT_NAME = "omitted optional flags (tenant settings)";
const tenantStore = new MinimalTenantSettingsStore();
describeTenantSettingsStoreConformance({
  name: TENANT_NAME,
  createStore: () => tenantStore,
  setDefaultHalfLifeHours: (ctx, hours) => tenantStore.setDefaultHalfLifeHours(ctx, hours),
  supportsDecayClock: false,
  supportsEraseTenant: false,
  // supportsTaxonomyMode は意図的に渡さない。
});

const VECTOR_NAME = "omitted optional flags (vector)";
let latestVectorMemoryStore: InMemoryMemoryStore | undefined;
let vectorHashCounter = 0;
describeVectorStoreConformance({
  name: VECTOR_NAME,
  createStore: () => {
    latestVectorMemoryStore = new InMemoryMemoryStore();
    return new InMemoryVectorStore(latestVectorMemoryStore);
  },
  prepareMemoryId: async (ctx, attrs) => {
    if (!latestVectorMemoryStore) throw new Error("createStore() より先に呼ばれた");
    vectorHashCounter += 1;
    const memory = await latestVectorMemoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `omitted-flags-vector-${vectorHashCounter}`,
        ...(attrs?.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs?.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs?.decayFloorAt !== undefined ? { decayFloorAt: attrs.decayFloorAt } : {}),
        ...(attrs?.decayFloorSeq !== undefined ? { decayFloorSeq: attrs.decayFloorSeq } : {}),
        ...(attrs?.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs?.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs?.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
        ...(attrs?.validFrom !== undefined ? { validFrom: attrs.validFrom } : {}),
        ...(attrs?.validUntil !== undefined ? { validUntil: attrs.validUntil } : {}),
        ...(attrs?.attributes !== undefined ? { attributes: attrs.attributes } : {}),
        ...(attrs?.tags !== undefined ? { tags: attrs.tags } : {}),
      }),
    );
    return memory.id;
  },
  prepareEmbeddingSpace: () => {},
  supportsGetVectors: true,
  supportsEraseTenant: true,
  // supportsSearchMany は意図的に渡さない。
});

const OUTBOX_NAME = "omitted optional flags (outbox)";
let latestOutboxMemoryStore: InMemoryMemoryStore | undefined;
describeOutboxStoreConformance({
  name: OUTBOX_NAME,
  createStore: () => {
    latestOutboxMemoryStore = new InMemoryMemoryStore();
    return new InMemoryOutboxStore(latestOutboxMemoryStore.outboxJobs);
  },
  seedJob: async (ctx, input) => {
    if (!latestOutboxMemoryStore) throw new Error("createStore() より先に呼ばれた");
    const { jobs } = await latestOutboxMemoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: ctx.tenantId, subjectId: null, externalId: null, kind: "utterance", payload: {} },
      [input.kind],
    );
    const job = latestOutboxMemoryStore.outboxJobs.find((j) => j.id === jobs[0]!.id)!;
    if (input.payload) job.payload = input.payload;
    if (input.availableAt) job.availableAt = input.availableAt;
    return job;
  },
  peekJob: async (_ctx, jobId) =>
    latestOutboxMemoryStore?.outboxJobs.find((j) => j.id === jobId) ?? null,
  supportsEraseTenant: true,
  // supportsPurgeCompletedJobs は意図的に渡さない。
});

function testsUnder(root: RunnerTask, needle: string): RunnerTask[] {
  const out: RunnerTask[] = [];
  const walk = (task: RunnerTask, inside: boolean) => {
    const here = inside || (task.type === "suite" && task.name.includes(needle));
    if (task.type === "test" && here) out.push(task);
    if ("tasks" in task) for (const child of task.tasks) walk(child, here);
  };
  walk(root, false);
  return out;
}

function expectOneUncheckedNamedIt(file: RunnerTask, suiteName: string, flags: string[]): void {
  const tests = testsUnder(file, suiteName);
  const names = tests.map((t) => t.name);
  const control = tests.find((t) => !t.name.includes("未検査"));
  expect(names.length, "suite が実際に登録されている").toBeGreaterThan(10);
  for (const flag of flags) {
    const unchecked = names.filter((n) =>
      n.startsWith(`⚠ 未検査: ${flag} が指定されていない — adapter "${suiteName}" に対して `),
    );
    expect(unchecked, flag).toHaveLength(1);
    if (control?.mode === "run") {
      expect(tests.find((t) => t.name === unchecked[0])?.mode, flag).toBe("run");
    }
  }
}

describe("docs/conformance.md §9: 任意フラグを省略したときに登録される it", () => {
  it("MemoryStore: 省略した任意フラグのそれぞれに「⚠ 未検査」の named it が1本ずつ登録される", ({
    task,
  }) => {
    const tests = testsUnder(task.file, MEMORY_NAME);
    const names = tests.map((t) => t.name);
    const control = tests.find((t) => !t.name.includes("未検査"));
    expect(names.length, "suite が実際に登録されている").toBeGreaterThan(100);
    for (const flag of [
      "supportsOnlyMemoryIdsFilter",
      "supportsLabels",
      "supportsFindActiveByClaimKey",
      "supportsFindContestedByClaimKey",
      "supportsListActiveClaimPredicates",
      "supportsResolveOrphanedContested",
      "supportsAbortIfForgotten",
      "supportsAbortIfSuperseded",
      "supportsAbortIfAllConflicted",
      "supportsPurgeExpiredEventsByRetention",
      "supportsMarkContestedGroup",
      "supportsResolveContestedGroup",
      "supportsPurgeExpiredRecalls",
      "supportsCreateMemoriesWithOutboxAndEvents",
      "supportsSupersedeCreatedEvents",
    ]) {
      const unchecked = names.filter((n) =>
        n.startsWith(`⚠ 未検査: ${flag} が指定されていない — adapter "${MEMORY_NAME}" に対して `),
      );
      expect(unchecked, flag).toHaveLength(1);
      // `-t` で絞ると絞った外の it はすべて skip になるので、同じ suite の普通の it が run のとき（絞り込みがこの suite を外していないとき）だけ mode を比べる。
      if (control?.mode === "run") {
        expect(tests.find((t) => t.name === unchecked[0])?.mode, flag).toBe("run");
      }
    }
  });

  it("VectorStore: supportsSearchMany を省略すると「⚠ 未検査」の named it が1本登録される", ({
    task,
  }) => {
    expectOneUncheckedNamedIt(task.file, VECTOR_NAME, ["supportsSearchMany"]);
  });

  it("OutboxStore: supportsPurgeCompletedJobs を省略すると「⚠ 未検査」の named it が1本登録される", ({
    task,
  }) => {
    expectOneUncheckedNamedIt(task.file, OUTBOX_NAME, ["supportsPurgeCompletedJobs"]);
  });

  it("MemoryStore: 関数フックの countScopeAggregateQueries を省略しても「⚠ 未検査」の named it が1本登録される（2状態）", ({
    task,
  }) => {
    expectOneUncheckedNamedIt(task.file, MEMORY_NAME, ["countScopeAggregateQueries"]);
  });

  it("TenantSettingsStore: supportsTaxonomyMode を省略すると、taxonomy mode の歯も「未検査」の it も登録されない（今の振る舞い）", ({
    task,
  }) => {
    const names = testsUnder(task.file, TENANT_NAME).map((t) => t.name);
    expect(names.length, "suite が実際に登録されている").toBeGreaterThan(0);
    expect(names.filter((n) => /TaxonomyMode/.test(n))).toEqual([]);
    expect(names.filter((n) => n.includes("未検査"))).toEqual([]);
  });
});
