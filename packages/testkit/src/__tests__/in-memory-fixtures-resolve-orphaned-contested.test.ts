// Issue #825（ADR 0150 追記）: `resolveContestedPair`（決定3の CAS）は、対向を forget した
// 生存側を戻せない——forget は `contestedWithId` に触れないため、生存側は `contested` の
// まま、対向はもう `contested` ではなくなり、CAS を満たせなくなる。
// `MemoryStore.resolveOrphanedContested?`（生存側1件だけを対象にした別の任意メソッド）を
// `InMemoryMemoryStore` に足した。ここは `packages/testkit` 内だけで完結する、Fake を
// 直接呼ぶ回帰テストである——`memory-store-conformance.ts`（適合テスト、外部の store
// 実装者も走らせる公開面）には要件を足さない
// （`in-memory-fixtures-getmany-dedupe.test.ts` 冒頭の同じ方針を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function event(memoryId: string, overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested_resolved", resolution: "orphan_reclaimed" },
    ...overrides,
  };
}

/** a/b を markContestedPair で対にし、b だけを forgotten にする（forget の意味論そのまま：contestedWithId には触れない）。 */
async function createOrphanedPair(store: InMemoryMemoryStore) {
  const a = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ contentHash: "orphaned-a", digest: "A" }),
  );
  const b = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ contentHash: "orphaned-b", digest: "B" }),
  );
  await store.markContestedPair(
    ctx,
    { id: a.id, event: event(a.id) },
    { id: b.id, event: event(b.id) },
  );
  await store.updateStatusWithEvent(ctx, b.id, "forgotten", {}, event(b.id, { kind: "forgotten" }));
  return { a, b };
}

describe("InMemoryMemoryStore.resolveOrphanedContested（Issue #825）", () => {
  it("CAS を満たせば生存側を active に戻し、contestedWithId を null にする。対向（forgotten）には触れない", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);

    const result = await store.resolveOrphanedContested!(ctx, {
      id: a.id,
      contestedWithId: b.id,
      event: event(a.id),
    });

    expect(result.memory.status).toBe("active");
    expect(result.memory.contestedWithId).toBeNull();
    expect(result.event.kind).toBe("updated");

    const storedA = await store.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(storedA?.contestedWithId).toBeNull();

    // 対向は一切書き換わっていない。
    const storedB = await store.get(ctx, b.id);
    expect(storedB?.status).toBe("forgotten");
    expect(storedB?.contestedWithId).toBe(a.id);
  });

  it("id が存在しなければ「memory not found」を投げ、何も書き込まない", async () => {
    const store = new InMemoryMemoryStore();
    const { b } = await createOrphanedPair(store);

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: "does-not-exist",
        contestedWithId: b.id,
        event: event("does-not-exist"),
      }),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("CAS 破れ（status が contested でない）: MemoryStatusConflictError を投げ、行は無傷", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);
    // a 自身が forget された後（呼び出し側の読み違い・TOCTOU を模す）。
    await store.updateStatusWithEvent(
      ctx,
      a.id,
      "forgotten",
      {},
      event(a.id, { kind: "forgotten" }),
    );

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: event(a.id),
      }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const storedA = await store.get(ctx, a.id);
    expect(storedA?.status).toBe("forgotten");
  });

  it("CAS 破れ（contestedWithId が一致しない）: MemoryStatusConflictError を投げ、行は無傷", async () => {
    const store = new InMemoryMemoryStore();
    const { a, b } = await createOrphanedPair(store);
    const other = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ contentHash: "orphaned-other", digest: "C" }),
    );

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: other.id,
        event: event(a.id),
      }),
    ).rejects.toBeInstanceOf(MemoryStatusConflictError);

    const storedA = await store.get(ctx, a.id);
    expect(storedA?.status).toBe("contested");
    expect(storedA?.contestedWithId).toBe(b.id);
  });
});
