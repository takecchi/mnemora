import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { purgeExpiredEventsForTenant } from "../event-retention-purge.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeTenantSettingsStore` の event retention が**テナントごと**に持たれていることの歯。
 *
 * **`packages/testkit` の `tenant-settings-store-conformance.ts` の対象ではない。**
 * `FakeTenantSettingsStore` は `packages/core` 自身の runtime テスト専用の別系統
 * （`fake-aggregate-scope-include-subjectless.test.ts` と同じ理由・同じ形）。
 *
 * 以前の Fake は `eventRetention` をインスタンスに1つだけ持ち、`ctx` を読まずに
 * 書き換えていた——テナント A に `setEventRetention` すると、テナント B の
 * `getEventRetention` も同じ値を返した。`TenantSettingsStore` はテナントの設定であり
 * （ADR 0050）、`ctx.tenantId` は隔離境界である（ADR 0007）。`InMemoryTenantSettingsStore`
 * と `PostgresTenantSettingsStore` はテナントごとに持っている。
 *
 * 害は Fake を使うテストの側に出る: `purgeExpiredEventsForTenant` を2テナントで
 * 走らせる歯を書くと、片方に設定した保持期間がもう片方のイベントまで消し、
 * 本物の adapter では起きないことを Fake が起こす（下の2つ目の it）。
 */

const ctxA: Ctx = { tenantId: "tenant-a" };
const ctxB: Ctx = { tenantId: "tenant-b" };

describe("FakeTenantSettingsStore の event retention はテナントごと（ADR 0007 / ADR 0050）", () => {
  it("テナント A に設定しても、テナント B は unset のまま", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();

    await tenantSettingsStore.setEventRetention(ctxA, { kind: "days", days: 7 });

    expect(await tenantSettingsStore.getEventRetention(ctxA)).toEqual({ kind: "days", days: 7 });
    expect(await tenantSettingsStore.getEventRetention(ctxB)).toEqual({ kind: "unset" });
  });

  it("テナント A の保持期間で、テナント B の古いイベントは消えない", async () => {
    const { memoryStore, eventStore, tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setEventRetention(ctxA, { kind: "days", days: 1 });

    const memoryB = await memoryStore.createMemory(ctxB, {
      tenantId: ctxB.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "retention-per-tenant-b",
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
    await eventStore.append(ctxB, {
      tenantId: ctxB.tenantId,
      memoryId: memoryB.id,
      kind: "updated",
      at: new Date("2000-01-01T00:00:00.000Z"),
      actor: { type: "system" },
      meta: {},
    });

    const outcome = await purgeExpiredEventsForTenant(
      ctxB,
      { memoryStore, tenantSettingsStore },
      { limit: 10, now: new Date("2024-01-01T00:00:00.000Z") },
    );

    expect(outcome).toEqual({ kind: "unset" });
    expect(await eventStore.list(ctxB, {})).toHaveLength(1);
  });
});
