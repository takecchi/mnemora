import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { purgeExpiredEventsForTenant } from "../event-retention-purge.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** モックを使わない: スパイで呼び出し引数だけを見ると `purgeExpiredEvents` 側の実装を差し替えても検査が気づかないので、`FakeMemoryStore.purgeExpiredEvents` を実際に呼び、積んだイベントが消えるかで `olderThan` の計算・引数の受け渡しを検査する。 */

const ctx: Ctx = { tenantId: "tenant-1" };

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

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: new Date("2024-01-01T00:00:00.000Z") },
    );

    expect(outcome).toEqual({ kind: "unset" });
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
  });

  it("retention が unlimited のとき、memoryStore には一切触れず { kind: 'unlimited' } を返す（イベントは1件も消えない）", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctx, { kind: "unlimited" });
    await seedOldEvent(memoryStore, eventStore, new Date("2000-01-01T00:00:00.000Z"));

    const outcome = await purgeExpiredEventsForTenant(
      ctx,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: new Date("2024-01-01T00:00:00.000Z") },
    );

    expect(outcome).toEqual({ kind: "unlimited" });
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
