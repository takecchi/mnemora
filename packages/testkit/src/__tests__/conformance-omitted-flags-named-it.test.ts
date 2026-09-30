import { describe, expect, it } from "vitest";
import {
  assertValidEventRetentionDays,
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

/**
 * `docs/conformance.md` §9 の約束を縛る: 任意の適合フラグを**省略**すると、`it.skip` ではなく
 * 「⚠ 未検査: <フラグ名> が指定されていない — adapter "<name>" に対して …」という named it が1本登録される。
 * 適合テストの中身は変えず、呼び出して、登録された it の名前を vitest の task の木から読むだけである。
 *
 * 同じ §9 の追記どおり、`TenantSettingsStoreConformanceOptions.supportsTaxonomyMode` だけは形が違い、
 * 省略すると taxonomy mode の歯も「未検査」の it も登録されない——今の振る舞いとして、それも固定する。
 */

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
  // Issue #1207 / ADR 0383: InMemoryMemoryStore は eraseTenant を実装している。
  supportsEraseTenant: true,
  // ⭐ 任意の10個（supportsOnlyMemoryIdsFilter / supportsLabels / supportsFindActiveByClaimKey /
  // supportsFindContestedByClaimKey / supportsListActiveClaimPredicates /
  // supportsResolveOrphanedContested / supportsAbortIfForgotten / supportsMarkContestedGroup /
  // supportsResolveContestedGroup / supportsPurgeExpiredRecalls）は意図的に渡さない。
});

/**
 * 必須の3口だけを持つ最小の store。`setDefaultHalfLifeHours` は適合テストへ渡すフック（store の口ではない）で、
 * 行が在るテナントは retention が未設定でも unlimited になる（Postgres の行と同じ3状態）。
 */
class MinimalTenantSettingsStore implements TenantSettingsStore {
  private readonly retention = new Map<string, EventRetentionSetting>();
  private readonly halfLifeHours = new Map<string, number>();
  setDefaultHalfLifeHours(ctx: Ctx, hours: number): void {
    if (!isHalfLifeHoursInRange(hours)) throw new Error(`half life hours out of range: ${hours}`);
    this.halfLifeHours.set(ctx.tenantId, hours);
  }
  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    return this.halfLifeHours.get(ctx.tenantId) ?? DEFAULT_HALF_LIFE_HOURS;
  }
  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
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
  // Issue #1207 / ADR 0383: MinimalTenantSettingsStore は eraseTenant を実装していない。
  supportsEraseTenant: false,
  // ⭐ supportsTaxonomyMode は意図的に渡さない。
});

/**
 * VectorStore: 必須の口（`supportsGetVectors`/`supportsEraseTenant`）だけを渡し、
 * `supportsSearchMany` は意図的に渡さない（Issue #1412 の続き）。
 */
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
  // ⭐ supportsSearchMany は意図的に渡さない。
});

/**
 * OutboxStore: `supportsPurgeCompletedJobs` を意図的に渡さない（ADR 0404）。
 * `supportsRealConcurrency` は省略/false で `it.skip` になる別の形なので対象外。
 */
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
  // ⭐ supportsPurgeCompletedJobs は意図的に渡さない。
});

/** task の木から、名前に `needle` を含む describe の下の it を全部集める。 */
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
    // `-t` で絞られて同じ suite の普通の it が run でないときは mode を比べない（MemoryStore の歯と同じ）。
    if (control?.mode === "run") {
      expect(tests.find((t) => t.name === unchecked[0])?.mode, flag).toBe("run");
    }
  }
}

describe("docs/conformance.md §9: 任意フラグを省略したときに登録される it", () => {
  it("MemoryStore: 省略した10個のフラグのそれぞれに「⚠ 未検査」の named it が1本ずつ登録される", ({
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
      "supportsMarkContestedGroup",
      "supportsResolveContestedGroup",
      "supportsPurgeExpiredRecalls",
    ]) {
      const unchecked = names.filter((n) =>
        n.startsWith(`⚠ 未検査: ${flag} が指定されていない — adapter "${MEMORY_NAME}" に対して `),
      );
      expect(unchecked, flag).toHaveLength(1);
      // `it.skip` ではなく、常に実行される it である（§9 の表の「省略」行）。
      // ⚠ `-t` で絞ると絞った外の it はすべて mode が skip になるので、同じ suite の普通の it が
      // run のとき（＝絞り込みがこの suite を外していないとき）だけ比べる。
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

  it("TenantSettingsStore: supportsTaxonomyMode を省略すると、taxonomy mode の歯も「未検査」の it も登録されない（今の振る舞い）", ({
    task,
  }) => {
    const names = testsUnder(task.file, TENANT_NAME).map((t) => t.name);
    expect(names.length, "suite が実際に登録されている").toBeGreaterThan(0);
    expect(names.filter((n) => /TaxonomyMode/.test(n))).toEqual([]);
    expect(names.filter((n) => n.includes("未検査"))).toEqual([]);
  });
});
