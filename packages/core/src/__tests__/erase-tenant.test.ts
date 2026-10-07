import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { eraseTenant } from "../erase-tenant.js";
import type { EraseTenantResult, EraseTenantStoreResult } from "../interfaces/memory-store.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 各 port の `eraseTenant?` の契約は `packages/testkit` の conformance suite が検査する。ここではオーケストレータ自身を検査するため、各 Fake の `eraseTenant` をテストごとに必要な形だけ差し替える。 */

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

  it("confirmTenantId は完全一致で比べる（大文字小文字・前後の空白・1文字違いは、書き込み前に RangeError で断る）", async () => {
    const mixedCtx: Ctx = { tenantId: "Acme" };
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(mixedCtx, {
      tenantId: mixedCtx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-confirm-exact",
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
    const deps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      outboxStore: stores.outboxStore,
      tenantSettingsStore: stores.tenantSettingsStore,
    };

    for (const confirmTenantId of [
      "acme",
      "ACME",
      " Acme",
      "Acme ",
      "Acme\n",
      "Acm",
      "Acmee",
      "Acne",
    ]) {
      await expect(eraseTenant(mixedCtx, deps, { confirmTenantId, limit: 10 })).rejects.toThrow(
        RangeError,
      );
    }
    expect(await stores.memoryStore.get(mixedCtx, memory.id)).not.toBeNull();

    const outcome = await eraseTenant(mixedCtx, deps, { confirmTenantId: "Acme", limit: 10 });
    expect(outcome.kind).toBe("executed");
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

  it("呼び出しの順序は memoryStore → vectorStore → outboxStore → tenantSettingsStore である", async () => {
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

    expect(order).toEqual(["memoryStore", "vectorStore", "outboxStore", "tenantSettingsStore"]);
  });

  it("memoryStore が blocked_by_foreign_reference を返したら、その count をそのまま返し、ほかの3つの port には触れない（途中まで消えた状態を残さない）", async () => {
    const stores = createFakeRuntimeStores();
    stores.memoryStore.eraseTenant = async (): Promise<EraseTenantStoreResult> => ({
      kind: "blocked_by_foreign_reference",
      count: 3,
    });
    const touched: string[] = [];
    const touch = (name: string) => async (): Promise<EraseTenantResult> => {
      touched.push(name);
      return { deleted: 0, reachedLimit: false };
    };
    stores.vectorStore.eraseTenant = touch("vectorStore");
    stores.outboxStore.eraseTenant = touch("outboxStore");
    stores.tenantSettingsStore.eraseTenant = touch("tenantSettingsStore");

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
    expect(touched).toEqual([]);
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

  it("他テナントの outbox・埋め込み・設定・冪等キーも消えない（対象テナントの分だけが消える）", async () => {
    const stores = createFakeRuntimeStores();
    const deps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      outboxStore: stores.outboxStore,
      tenantSettingsStore: stores.tenantSettingsStore,
    };
    const otherCtx: Ctx = { tenantId: "tenant-other" };
    const SPACE = { provider: "fake", model: "fake-model", dimensions: 2 };
    const outboxJobs = (
      stores.outboxStore as unknown as {
        backing: { outboxJobs: { tenantId: string }[] };
      }
    ).backing.outboxJobs;
    const jobsOf = (tenantId: string) => outboxJobs.filter((j) => j.tenantId === tenantId).length;

    const seed = async (c: Ctx) => {
      const { observation } = await stores.memoryStore.createObservationWithOutbox(
        c,
        {
          tenantId: c.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: { text: "x" },
        },
        ["extract"],
      );
      const input = {
        tenantId: c.tenantId,
        subjectId: null,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        content: "本文",
        contentHash: "hash-idempotency-shared",
        digest: "digest",
        digestSource: "llm" as const,
        provenance: { kind: "imported" as const, batchId: "fixture" },
        tags: [],
        occurredAt: null,
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: 720,
        decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
        embeddingStatus: "pending" as const,
      };
      const created = await stores.memoryStore.createMemoryWithOutbox(c, input, ["embed"]);
      await stores.vectorStore.upsert(c, SPACE, created.memory.id, [1, 2]);
      await stores.tenantSettingsStore.setEventRetention(c, { kind: "days", days: 30 });
      return { input, memoryId: created.memory.id };
    };
    const mine = await seed(ctx);
    const other = await seed(otherCtx);
    expect(jobsOf(otherCtx.tenantId)).toBe(2);
    expect(stores.vectorStore.entries.size).toBe(2);

    const outcome = await eraseTenant(ctx, deps, { confirmTenantId: ctx.tenantId, limit: 100 });
    expect(outcome.kind).toBe("executed");

    expect(await stores.memoryStore.get(ctx, mine.memoryId)).toBeNull();
    expect(jobsOf(ctx.tenantId)).toBe(0);
    expect(await stores.tenantSettingsStore.getEventRetention(ctx)).toEqual({ kind: "unset" });

    expect(await stores.memoryStore.get(otherCtx, other.memoryId)).not.toBeNull();
    expect(jobsOf(otherCtx.tenantId)).toBe(2);
    expect(stores.vectorStore.entries.size).toBe(1);
    expect([...stores.vectorStore.entries.values()].map((e) => e.tenantId)).toEqual([
      otherCtx.tenantId,
    ]);
    expect(await stores.tenantSettingsStore.getEventRetention(otherCtx)).toEqual({
      kind: "days",
      days: 30,
    });
    const again = await stores.memoryStore.createMemoryWithOutbox(otherCtx, other.input, ["embed"]);
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(other.memoryId);
  });
});

/** 設定は最後にする: 途中で処理が中断しても「テナントが存在する」手がかりとして残る（ADR 0383）。`limit` で止まった回に後ろの port へ進むとこの約束が破れる。 */
describe("eraseTenant: limit で止まった回は、後ろの port を呼ばない（ADR 0383 の追記）", () => {
  const memoryInput = (i: number) => ({
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文${i}`,
    contentHash: `hash-stop-at-limit-${i}`,
    digest: "digest",
    digestSource: "llm" as const,
    provenance: { kind: "imported" as const, batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending" as const,
  });

  const SPACE = { provider: "fake", model: "fake-model", dimensions: 2 };

  type Stores = ReturnType<typeof createFakeRuntimeStores>;

  async function seed(stores: Stores) {
    for (let i = 0; i < 3; i++) {
      const m = await stores.memoryStore.createMemory(ctx, memoryInput(i));
      await stores.vectorStore.upsert(ctx, SPACE, m.id, [1, 2]);
    }
    for (let i = 0; i < 2; i++) {
      await stores.memoryStore.createObservationWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: { text: `x${i}` },
        },
        ["extract"],
      );
    }
    await stores.tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 30 });
  }

  const outboxCount = (stores: Stores): number =>
    (
      stores.outboxStore as unknown as { backing: { outboxJobs: { tenantId: string }[] } }
    ).backing.outboxJobs.filter((j) => j.tenantId === ctx.tenantId).length;

  const depsOf = (stores: Stores) => ({
    memoryStore: stores.memoryStore,
    vectorStore: stores.vectorStore,
    outboxStore: stores.outboxStore,
    tenantSettingsStore: stores.tenantSettingsStore,
  });

  it("memoryStore が reachedLimit のとき、埋め込み・outbox・設定は残り、reachedLimit: true で返る（呼ばなかった port の deleted は 0）", async () => {
    const stores = createFakeRuntimeStores();
    await seed(stores);
    const vectorsBefore = stores.vectorStore.entries.size;
    const jobsBefore = outboxCount(stores);
    expect(vectorsBefore).toBe(3);
    expect(jobsBefore).toBe(2);

    const outcome = await eraseTenant(ctx, depsOf(stores), {
      confirmTenantId: ctx.tenantId,
      limit: 2,
    });

    expect(outcome).toEqual({
      kind: "executed",
      dryRun: false,
      deleted: { memoryStore: 2, vectorStore: 0, outboxStore: 0, tenantSettingsStore: 0 },
      reachedLimit: true,
    });
    expect(stores.vectorStore.entries.size).toBe(vectorsBefore);
    expect(outboxCount(stores)).toBe(jobsBefore);
    expect(await stores.tenantSettingsStore.getEventRetention(ctx)).toEqual({
      kind: "days",
      days: 30,
    });
  });

  it("呼び直すと最後まで消え、全部が空になった回で reachedLimit: false になる（設定が消えるのは最後の回）", async () => {
    const stores = createFakeRuntimeStores();
    await seed(stores);

    let calls = 0;
    for (;;) {
      calls += 1;
      expect(calls).toBeLessThan(20);
      const outcome = await eraseTenant(ctx, depsOf(stores), {
        confirmTenantId: ctx.tenantId,
        limit: 2,
      });
      expect(outcome.kind).toBe("executed");
      if (outcome.kind !== "executed") throw new Error("unreachable");
      if (!outcome.reachedLimit) break;
      expect(await stores.tenantSettingsStore.getEventRetention(ctx)).toEqual({
        kind: "days",
        days: 30,
      });
    }
    expect(calls).toBeGreaterThan(1);
    expect(stores.vectorStore.entries.size).toBe(0);
    expect(outboxCount(stores)).toBe(0);
    expect(await stores.tenantSettingsStore.getEventRetention(ctx)).toEqual({ kind: "unset" });
  });

  it("vectorStore が reachedLimit のとき、outboxStore・tenantSettingsStore を呼ばない", async () => {
    const stores = createFakeRuntimeStores();
    const touched: string[] = [];
    stores.memoryStore.eraseTenant = async () => ({
      kind: "executed",
      deleted: 0,
      reachedLimit: false,
    });
    stores.vectorStore.eraseTenant = async () => ({ deleted: 5, reachedLimit: true });
    stores.outboxStore.eraseTenant = async () => {
      touched.push("outboxStore");
      return { deleted: 0, reachedLimit: false };
    };
    stores.tenantSettingsStore.eraseTenant = async () => {
      touched.push("tenantSettingsStore");
      return { deleted: 0, reachedLimit: false };
    };

    const outcome = await eraseTenant(ctx, depsOf(stores), {
      confirmTenantId: ctx.tenantId,
      limit: 5,
    });

    expect(touched).toEqual([]);
    expect(outcome).toEqual({
      kind: "executed",
      dryRun: false,
      deleted: { memoryStore: 0, vectorStore: 5, outboxStore: 0, tenantSettingsStore: 0 },
      reachedLimit: true,
    });
  });

  it("outboxStore が reachedLimit のとき、tenantSettingsStore を呼ばない", async () => {
    const stores = createFakeRuntimeStores();
    const touched: string[] = [];
    stores.memoryStore.eraseTenant = async () => ({
      kind: "executed",
      deleted: 1,
      reachedLimit: false,
    });
    stores.vectorStore.eraseTenant = async () => ({ deleted: 2, reachedLimit: false });
    stores.outboxStore.eraseTenant = async () => ({ deleted: 5, reachedLimit: true });
    stores.tenantSettingsStore.eraseTenant = async () => {
      touched.push("tenantSettingsStore");
      return { deleted: 1, reachedLimit: false };
    };

    const outcome = await eraseTenant(ctx, depsOf(stores), {
      confirmTenantId: ctx.tenantId,
      limit: 5,
    });

    expect(touched).toEqual([]);
    expect(outcome).toEqual({
      kind: "executed",
      dryRun: false,
      deleted: { memoryStore: 1, vectorStore: 2, outboxStore: 5, tenantSettingsStore: 0 },
      reachedLimit: true,
    });
  });

  it("dryRun でも同じ: memoryStore が reachedLimit なら後ろの port を呼ばず、deleted は 0 で reachedLimit: true", async () => {
    const stores = createFakeRuntimeStores();
    await seed(stores);

    const outcome = await eraseTenant(ctx, depsOf(stores), {
      confirmTenantId: ctx.tenantId,
      limit: 2,
      dryRun: true,
    });

    expect(outcome).toEqual({
      kind: "executed",
      dryRun: true,
      deleted: { memoryStore: 2, vectorStore: 0, outboxStore: 0, tenantSettingsStore: 0 },
      reachedLimit: true,
    });
  });
});
