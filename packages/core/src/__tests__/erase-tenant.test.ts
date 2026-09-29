import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { eraseTenant } from "../erase-tenant.js";
import type { EraseTenantResult, EraseTenantStoreResult } from "../interfaces/memory-store.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `eraseTenant`（Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md)）
 * の歯。オーケストレータ自身（4つの port を束ねる部分）を検査する——各 port の
 * `eraseTenant?` 実装そのものの契約は `packages/testkit` の conformance suite
 * （`supportsEraseTenant`）が検査するので、ここでは `FakeMemoryStore`/`FakeVectorStore`/
 * `FakeOutboxStore`/`FakeTenantSettingsStore` の `eraseTenant` を、テストごとに必要な形
 * だけ差し替えて使う（`event-retention-purge.test.ts` が
 * `purgeExpiredEventsByRetention = undefined` で「口が無い」状態を模すのと同じ作法）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

describe("eraseTenant（Issue #1207 / ADR 0383）", () => {
  it("opts.confirmTenantId が ctx.tenantId と一致しないとき、書き込み前に RangeError を投げる（何も消えない）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-confirm-mismatch",
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

    await expect(
      eraseTenant(
        ctx,
        {
          memoryStore: stores.memoryStore,
          vectorStore: stores.vectorStore,
          outboxStore: stores.outboxStore,
          tenantSettingsStore: stores.tenantSettingsStore,
        },
        { confirmTenantId: "tenant-2", limit: 10 },
      ),
    ).rejects.toThrow(RangeError);
    expect(await stores.memoryStore.get(ctx, memory.id)).not.toBeNull();
  });

  it("opts.limit が正の整数でないとき、書き込み前に RangeError を投げる（0・負数・非整数のいずれも）", async () => {
    const stores = createFakeRuntimeStores();
    const deps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      outboxStore: stores.outboxStore,
      tenantSettingsStore: stores.tenantSettingsStore,
    };
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("4 port のうち eraseTenant を実装していない port が1つでもあれば、何も消さずに store_unsupported を返す（missing に port 名が名指しされる）", async () => {
    const stores = createFakeRuntimeStores();
    // `memories` に1件書いておく——store_unsupported なら消えないことを確認するため。
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-store-unsupported",
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

    // `vectorStore` だけ口を持たない状態を作る（`FakeVectorStore.eraseTenant` はプロトタイプの
    // メソッドなので `delete` では消えない——`undefined` を明示代入する）。
    (stores.vectorStore as { eraseTenant?: unknown }).eraseTenant = undefined;

    const outcome = await eraseTenant(
      ctx,
      {
        memoryStore: stores.memoryStore,
        vectorStore: stores.vectorStore,
        outboxStore: stores.outboxStore,
        tenantSettingsStore: stores.tenantSettingsStore,
      },
      { confirmTenantId: ctx.tenantId, limit: 100 },
    );

    expect(outcome).toEqual({ kind: "store_unsupported", missing: ["vectorStore"] });
    // 何も消えていないこと。
    expect(await stores.memoryStore.get(ctx, memory.id)).not.toBeNull();
  });

  it("複数の port が欠けていれば、missing にそのすべてが名指しされる", async () => {
    const stores = createFakeRuntimeStores();
    (stores.vectorStore as { eraseTenant?: unknown }).eraseTenant = undefined;
    (stores.outboxStore as { eraseTenant?: unknown }).eraseTenant = undefined;

    const outcome = await eraseTenant(
      ctx,
      {
        memoryStore: stores.memoryStore,
        vectorStore: stores.vectorStore,
        outboxStore: stores.outboxStore,
        tenantSettingsStore: stores.tenantSettingsStore,
      },
      { confirmTenantId: ctx.tenantId, limit: 100 },
    );

    expect(outcome).toEqual({
      kind: "store_unsupported",
      missing: ["vectorStore", "outboxStore"],
    });
  });

  it("呼び出しの順序は vectorStore → outboxStore → memoryStore → tenantSettingsStore である", async () => {
    const stores = createFakeRuntimeStores();
    const order: string[] = [];
    const wrap =
      (name: string, result: EraseTenantResult) => async (): Promise<EraseTenantResult> => {
        order.push(name);
        return result;
      };
    const wrapMemory =
      (name: string, result: EraseTenantStoreResult) =>
      async (): Promise<EraseTenantStoreResult> => {
        order.push(name);
        return result;
      };
    stores.vectorStore.eraseTenant = wrap("vectorStore", { deleted: 0, reachedLimit: false });
    stores.outboxStore.eraseTenant = wrap("outboxStore", { deleted: 0, reachedLimit: false });
    stores.memoryStore.eraseTenant = wrapMemory("memoryStore", {
      kind: "executed",
      deleted: 0,
      reachedLimit: false,
    });
    stores.tenantSettingsStore.eraseTenant = wrap("tenantSettingsStore", {
      deleted: 0,
      reachedLimit: false,
    });

    await eraseTenant(
      ctx,
      {
        memoryStore: stores.memoryStore,
        vectorStore: stores.vectorStore,
        outboxStore: stores.outboxStore,
        tenantSettingsStore: stores.tenantSettingsStore,
      },
      { confirmTenantId: ctx.tenantId, limit: 100 },
    );

    expect(order).toEqual(["vectorStore", "outboxStore", "memoryStore", "tenantSettingsStore"]);
  });

  it("memoryStore が blocked_by_foreign_reference を返したら、その count をそのまま返し、tenantSettingsStore には触れない", async () => {
    const stores = createFakeRuntimeStores();
    stores.memoryStore.eraseTenant = async (): Promise<EraseTenantStoreResult> => ({
      kind: "blocked_by_foreign_reference",
      count: 3,
    });
    let tenantSettingsTouched = false;
    stores.tenantSettingsStore.eraseTenant = async (): Promise<EraseTenantResult> => {
      tenantSettingsTouched = true;
      return { deleted: 0, reachedLimit: false };
    };

    const outcome = await eraseTenant(
      ctx,
      {
        memoryStore: stores.memoryStore,
        vectorStore: stores.vectorStore,
        outboxStore: stores.outboxStore,
        tenantSettingsStore: stores.tenantSettingsStore,
      },
      { confirmTenantId: ctx.tenantId, limit: 100 },
    );

    expect(outcome).toEqual({ kind: "blocked_by_foreign_reference", count: 3 });
    expect(tenantSettingsTouched).toBe(false);
  });

  it("いずれかの port の eraseTenant が例外を投げたら、その例外をそのまま素通しする", async () => {
    const stores = createFakeRuntimeStores();
    const boom = new Error("boom");
    stores.outboxStore.eraseTenant = async (): Promise<EraseTenantResult> => {
      throw boom;
    };

    await expect(
      eraseTenant(
        ctx,
        {
          memoryStore: stores.memoryStore,
          vectorStore: stores.vectorStore,
          outboxStore: stores.outboxStore,
          tenantSettingsStore: stores.tenantSettingsStore,
        },
        { confirmTenantId: ctx.tenantId, limit: 100 },
      ),
    ).rejects.toThrow(boom);
  });

  it("reachedLimit のとき、呼び直すことで最終的にすべて消える（何度呼んでも安全）", async () => {
    const stores = createFakeRuntimeStores();
    const deps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      outboxStore: stores.outboxStore,
      tenantSettingsStore: stores.tenantSettingsStore,
    };
    // 3件の memory を作る——limit を小さくして複数回の呼び出しが必要になるようにする。
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const memory = await stores.memoryStore.createMemory(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        sourceObservationId: null,
        extractorVersion: null,
        content: `本文${i}`,
        contentHash: `hash-reached-limit-${i}`,
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
      ids.push(memory.id);
    }

    let reachedLimit = true;
    let calls = 0;
    while (reachedLimit) {
      calls += 1;
      expect(calls).toBeLessThan(20); // 無限ループの安全弁
      const outcome = await eraseTenant(ctx, deps, {
        confirmTenantId: ctx.tenantId,
        limit: 1,
      });
      expect(outcome.kind).toBe("executed");
      if (outcome.kind !== "executed") throw new Error("unreachable");
      reachedLimit = outcome.reachedLimit;
    }
    expect(calls).toBeGreaterThan(1);

    for (const id of ids) {
      expect(await stores.memoryStore.get(ctx, id)).toBeNull();
    }
  });

  it("dryRun: true のときは何も消えないが、deleted に消えるはずだった件数が入る", async () => {
    const stores = createFakeRuntimeStores();
    const deps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      outboxStore: stores.outboxStore,
      tenantSettingsStore: stores.tenantSettingsStore,
    };
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-dry-run",
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

    const outcome = await eraseTenant(ctx, deps, {
      confirmTenantId: ctx.tenantId,
      limit: 100,
      dryRun: true,
    });

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.dryRun).toBe(true);
    expect(outcome.deleted.memoryStore).toBeGreaterThan(0);
    expect(await stores.memoryStore.get(ctx, memory.id)).not.toBeNull();
  });

  it("他テナントの行は一切変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const deps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      outboxStore: stores.outboxStore,
      tenantSettingsStore: stores.tenantSettingsStore,
    };
    const otherCtx: Ctx = { tenantId: "tenant-other" };
    const otherMemory = await stores.memoryStore.createMemory(otherCtx, {
      tenantId: otherCtx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "他テナントの本文",
      contentHash: "hash-other-tenant",
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
    await stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-mine",
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

    const outcome = await eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit: 100 });
    expect(outcome.kind).toBe("executed");

    expect(await stores.memoryStore.get(otherCtx, otherMemory.id)).not.toBeNull();
  });
});
