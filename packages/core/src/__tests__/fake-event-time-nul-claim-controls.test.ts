import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { NewMemoryEvent } from "../event.js";
import { isMalformedIdentifierError } from "../identifier.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0573: ADR 0563 の歯の穴（独立検証で生き残った変異 A2・P2・N5・C6）を塞ぐ。
 *
 * - A2/P2: `archiveDecayed`・`purgeMemory` が行に書く `updatedAt` は壁時計（Postgres は `updated_at = now()`）。
 *   `opts.now`・`event.at` を入れてはいけない（`archived` イベントの `at`・`purgedAt` は逆にそちら）。
 * - N5: `createMemory` の `extractorVersion` の NUL は、素の `Error`（`MalformedIdentifierError` ではない）。
 *   InMemory は `stringHasNul` の素の `Error`、Postgres は `assertNoNulInNewMemory` の素の `Error`で、どちらも
 *   `extractorVersion` は識別子ではなく `text` の欄として扱う。
 * - C6: `listActiveClaimPredicates` は predicate ごとの最新の `createdAt` の新しい順、同着は predicate の順。
 *   既存の `fake-list-claim-predicates-partial-claim-key.test.ts` の同題の歯は `result.sort()` をかけて比べるので並びを見ていない。
 *
 * **testkit の適合テストの対象ではない**（Issue #768 コメント2）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let n = 0;

function memory(over: Partial<NewMemory> = {}): NewMemory {
  n += 1;
  return {
    tenantId: "tenant-1",
    subjectId: "user-1",
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `event-time-nul-claim-controls-${n}`,
    digest: "要旨",
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
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("updatedAt は壁時計（Postgres の updated_at = now()）。opts.now・event.at ではない", () => {
  it("archiveDecayed: opts.now が 2031 年でも、archive した行の updatedAt は呼ぶ前と後の間の壁時計", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const now = new Date("2031-01-01T00:00:00.000Z");
    const created = await memoryStore.createMemory(
      ctx,
      memory({ decayFloorAt: new Date(now.getTime() - 1_000) }),
    );

    const before = Date.now();
    const result = await memoryStore.archiveDecayed!(ctx, { now, limit: 10 });
    const after = Date.now();

    expect(result.archived.map((a) => a.memoryId)).toEqual([created.id]);
    const stored = await memoryStore.get(ctx, created.id);
    expect(stored?.status).toBe("archived");
    expect(stored!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored!.updatedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("purgeMemory: event.at が 2020 年でも、purge した行の updatedAt は呼ぶ前と後の間の壁時計（purgedAt は event.at）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const created = await memoryStore.createMemory(ctx, memory({ status: "forgotten" }));
    const at = new Date("2020-01-01T00:00:00.000Z");
    const event: NewMemoryEvent = {
      tenantId: "tenant-1",
      memoryId: created.id,
      kind: "purged",
      at,
      actor: { type: "system" },
      digestSnapshot: "要旨",
      meta: {},
    };

    const before = Date.now();
    await memoryStore.purgeMemory!(
      ctx,
      created.id,
      { content: "[purged]", digest: "[purged]" },
      event,
    );
    const after = Date.now();

    const stored = await memoryStore.get(ctx, created.id);
    expect(stored?.purgedAt).toEqual(at);
    expect(stored!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored!.updatedAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("createMemory の extractorVersion の NUL は素の Error（識別子ではなく text の欄）", () => {
  it("MalformedIdentifierError ではなく、extractorVersion must not contain NUL の素の Error で断り、何も書かない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const error = await memoryStore.createMemory(ctx, memory({ extractorVersion: "v\u0000" })).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isMalformedIdentifierError(error)).toBe(false);
    expect((error as Error).message).toMatch(/extractorVersion must not contain NUL/);
    await expect(
      memoryStore.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("対照: NUL の無い extractorVersion は通る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const created = await memoryStore.createMemory(ctx, memory({ extractorVersion: "v1" }));
    expect(created.extractorVersion).toBe("v1");
  });
});

describe("listActiveClaimPredicates の並び（新しい順、同着は predicate の順）", () => {
  const claim = (predicate: string): Partial<NewMemory> => ({
    claimKey: { subject: "user", predicate },
  });

  it("作成時刻の異なる2行は、新しい方が先", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { memoryStore } = createFakeRuntimeStores();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await memoryStore.createMemory(ctx, memory(claim("a_older")));
    vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    await memoryStore.createMemory(ctx, memory(claim("b_newer")));

    await expect(
      memoryStore.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 10 }),
    ).resolves.toEqual(["b_newer", "a_older"]);
    await expect(
      memoryStore.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 1 }),
    ).resolves.toEqual(["b_newer"]);
  });

  it("同じ predicate の複数行は、いちばん新しい行の時刻で並ぶ", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { memoryStore } = createFakeRuntimeStores();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await memoryStore.createMemory(ctx, memory(claim("y")));
    vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    await memoryStore.createMemory(ctx, memory(claim("x")));
    vi.setSystemTime(new Date("2030-01-03T00:00:00.000Z"));
    await memoryStore.createMemory(ctx, memory(claim("y")));

    await expect(
      memoryStore.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 10 }),
    ).resolves.toEqual(["y", "x"]);
  });

  it("作成時刻が同じなら、predicate のコードポイント順（挿入の順ではない）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { memoryStore } = createFakeRuntimeStores();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await memoryStore.createMemory(ctx, memory(claim("b")));
    await memoryStore.createMemory(ctx, memory(claim("c")));
    await memoryStore.createMemory(ctx, memory(claim("a")));

    await expect(
      memoryStore.listActiveClaimPredicates!(ctx, { subjectId: "user-1", limit: 10 }),
    ).resolves.toEqual(["a", "b", "c"]);
  });
});
