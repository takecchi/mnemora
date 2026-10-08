import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { purgeExpiredEventsForTenant } from "../event-retention-purge.js";
import type {
  MemoryStore,
  PurgeExpiredEventsByRetentionOptions,
  PurgeExpiredEventsByRetentionOutcome,
} from "../interfaces/memory-store.js";
import type { TenantSettingsStore } from "../interfaces/tenant-settings-store.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** モックを使わない: スパイで呼び出し引数だけを見ると `purgeExpiredEvents` 側の実装を差し替えても検査が気づかないので、`FakeMemoryStore.purgeExpiredEvents` を実際に呼び、積んだイベントが消えるかで `olderThan` の計算・引数の受け渡しを検査する。 */

const ctx: Ctx = { tenantId: "tenant-1" };

/** 削除の口を呼んだ回数を数える。本物の `FakeMemoryStore` の実装へそのまま委ねる（差し替えない）。 */
function countPurgeCalls(
  memoryStore: ReturnType<typeof createFakeRuntimeStores>["memoryStore"],
): { calls: number } {
  const counter = { calls: 0 };
  const byRetention = memoryStore.purgeExpiredEventsByRetention.bind(memoryStore);
  memoryStore.purgeExpiredEventsByRetention = async (c, o) => {
    counter.calls += 1;
    return byRetention(c, o);
  };
  const direct = memoryStore.purgeExpiredEvents.bind(memoryStore);
  memoryStore.purgeExpiredEvents = async (c, o) => {
    counter.calls += 1;
    return direct(c, o);
  };
  return counter;
}

async function seedOldEvent(
  memoryStore: ReturnType<typeof createFakeRuntimeStores>["memoryStore"],
  eventStore: ReturnType<typeof createFakeRuntimeStores>["eventStore"],
  at: Date,
): Promise<void> {
  const memory = await memoryStore.createMemory(ctx, {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `purge-orchestrator-${at.getTime()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  });
  await eventStore.append(ctx, {
    tenantId: "tenant-1",
    memoryId: memory.id,
    kind: "updated",
    at,
    actor: { type: "system" },
    meta: {},
  });
}

describe("purgeExpiredEventsForTenant（Issue #210 / ADR 0115）", () => {
  it("retention が unset のとき、memoryStore には一切触れず { kind: 'unset' } を返す（イベントは1件も消えない）", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await seedOldEvent(memoryStore, eventStore, new Date("2000-01-01T00:00:00.000Z"));
    const touched = countPurgeCalls(memoryStore);

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: new Date("2024-01-01T00:00:00.000Z") },
    );

    expect(outcome).toEqual({ kind: "unset" });
    expect(touched.calls).toBe(0);
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });

  it("retention が unlimited のとき、memoryStore には一切触れず { kind: 'unlimited' } を返す（イベントは1件も消えない）", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "unlimited" });
    await seedOldEvent(memoryStore, eventStore, new Date("2000-01-01T00:00:00.000Z"));
    const touched = countPurgeCalls(memoryStore);

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: new Date("2024-01-01T00:00:00.000Z") },
    );

    expect(outcome).toEqual({ kind: "unlimited" });
    expect(touched.calls).toBe(0);
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });

  it("retention が days だが store が purgeExpiredEventsByRetention を実装していないとき { kind: 'store_unsupported' } を返す（purgeExpiredEvents を実装していても、旧経路へは落ちない）", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 30 });
    await seedOldEvent(memoryStore, eventStore, new Date("2000-01-01T00:00:00.000Z"));
    // 新しい原子的な口だけを持たない adapter を模す。`purgeExpiredEvents` はあえて残す（旧経路への自動フォールバックは無い、という決定を検査するため）。
    // `delete` は使わない: `purgeExpiredEventsByRetention` はプロトタイプのメソッドなので `delete instance.method` は何もしない。`undefined` を明示的に代入する。
    (memoryStore as { purgeExpiredEventsByRetention?: unknown }).purgeExpiredEventsByRetention =
      undefined;
    expect(memoryStore.purgeExpiredEvents).toBeDefined();

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10 },
    );

    expect(outcome).toEqual({ kind: "store_unsupported" });
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });

  it("retention が days のとき、now から days 日ぶん遡った olderThan で実際に削除する", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 7 });

    const now = new Date("2024-06-08T00:00:00.000Z");
    await seedOldEvent(memoryStore, eventStore, new Date("2024-05-31T00:00:00.000Z")); // 対象
    await seedOldEvent(memoryStore, eventStore, new Date("2024-06-02T00:00:00.000Z")); // 対象外

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 25, now },
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.result.purged).toBe(1);
    expect(outcome.result.oldestPurgedAt).toEqual(new Date("2024-05-31T00:00:00.000Z"));

    const remaining = await eventStore.list(ctx, {});
    const remainingOriginal = remaining.filter((e) => e.kind !== "events_purged");
    expect(remainingOriginal).toHaveLength(1);
    expect(remainingOriginal[0]?.at).toEqual(new Date("2024-06-02T00:00:00.000Z"));
  });

  it("opts.now を省略すると、呼び出し時点の Date.now() を基準に cutoff を計算する（1日前は消え、1年前より新しいものは残る）", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 1 });

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const now = new Date(); // まだ1日経っていない
    await seedOldEvent(memoryStore, eventStore, twoDaysAgo);
    await seedOldEvent(memoryStore, eventStore, now);

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10 },
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.result.purged).toBe(1);

    const remainingOriginal = (await eventStore.list(ctx, {})).filter(
      (e) => e.kind !== "events_purged",
    );
    expect(remainingOriginal).toHaveLength(1);
    expect(remainingOriginal[0]?.at.getTime()).toBeGreaterThan(twoDaysAgo.getTime());
  });
});

describe("purgeExpiredEventsForTenant — opts を store へそのまま渡す", () => {
  it("dryRun: true なら store も dryRun で動き、1行も消さず events_purged も積まない", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 7 });
    await seedOldEvent(memoryStore, eventStore, new Date("2024-05-31T00:00:00.000Z"));

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: new Date("2024-06-08T00:00:00.000Z"), dryRun: true },
    );

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.result.dryRun).toBe(true);
    expect(outcome.result.purged).toBe(1);
    const events = await eventStore.list(ctx, {});
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("updated");
  });

  it("limit はちょうどの件数で効く: 対象3件に limit 2 なら2件だけ消し、limit 3 なら3件とも消す", async () => {
    const days = Array.from({ length: 3 }, (_, i) => new Date(`2024-05-0${i + 1}T00:00:00.000Z`));

    const fewer = createFakeRuntimeStores();
    await fewer.tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 7 });
    for (const at of days) await seedOldEvent(fewer.memoryStore, fewer.eventStore, at);
    const cut = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore: fewer.memoryStore, tenantSettingsStore: fewer.tenantSettingsStore },
      { limit: 2, now: new Date("2024-06-08T00:00:00.000Z") },
    );
    expect(cut.kind).toBe("executed");
    if (cut.kind !== "executed") throw new Error("unreachable");
    expect(cut.result.purged).toBe(2);
    expect(cut.result.reachedLimit).toBe(true);

    const exact = createFakeRuntimeStores();
    await exact.tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 7 });
    for (const at of days) await seedOldEvent(exact.memoryStore, exact.eventStore, at);
    const all = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore: exact.memoryStore, tenantSettingsStore: exact.tenantSettingsStore },
      { limit: 3, now: new Date("2024-06-08T00:00:00.000Z") },
    );
    expect(all.kind).toBe("executed");
    if (all.kind !== "executed") throw new Error("unreachable");
    expect(all.result.purged).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "limit の検査はしない: limit %s でも自分では投げず、その値のまま store へ渡す",
    async (limit) => {
      const received: PurgeExpiredEventsByRetentionOptions[] = [];
      const memoryStore = {
        async purgeExpiredEventsByRetention(
          _ctx: Ctx,
          opts: PurgeExpiredEventsByRetentionOptions,
        ): Promise<PurgeExpiredEventsByRetentionOutcome> {
          received.push(opts);
          return { kind: "unset" };
        },
      } as unknown as MemoryStore;
      const tenantSettingsStore = {
        async getEventRetention() {
          return { kind: "days", days: 7 } as const;
        },
      } as unknown as TenantSettingsStore;

      await expect(
        purgeExpiredEventsForTenant(ctx, { memoryStore, tenantSettingsStore }, { limit }),
      ).resolves.toEqual({ kind: "unset" });
      expect(received).toHaveLength(1);
      expect(received[0]?.limit).toBe(limit);
    },
  );
});

describe("purgeExpiredEventsForTenant — store が読み直した結果をそのまま返す", () => {
  // 関数が days と読んだ後、store が読み直すまでに setEventRetention が走った場面。関数に渡す設定の口だけが古い days を返す。
  it.each([
    ["unset", null],
    ["unlimited", { kind: "unlimited" }],
  ] as const)("store の読み直しが %s なら、その値を返し、1行も消さない", async (kind, setting) => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    if (setting) await tenantSettingsStore.setEventRetention(ctx, setting);
    await seedOldEvent(memoryStore, eventStore, new Date("2000-01-01T00:00:00.000Z"));
    const staleRead = {
      async getEventRetention() {
        return { kind: "days", days: 7 } as const;
      },
    } as unknown as TenantSettingsStore;

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore: staleRead },
      { limit: 10, now: new Date("2024-01-01T00:00:00.000Z") },
    );

    expect(outcome).toEqual({ kind });
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });
});
