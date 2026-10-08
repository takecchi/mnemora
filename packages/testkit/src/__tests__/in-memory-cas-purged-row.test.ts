import { describe, expect, it } from "vitest";
import {
  MemoryStatusConflictError,
  type Ctx,
  type MemoryId,
  type NewMemoryEvent,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * purge 済みの行（`status` は `forgotten` のまま・`purgedAt` が入っている）は、`expectedStatus: "forgotten"` の CAS にも一致しない
 * （ADR 0549）。`packages/core/src/__tests__/fake-cas-purged-row.test.ts`（Fake）と、`@mnemora/postgres` の
 * `cas-purged-row.postgres.test.ts` と同じ帰結を、InMemory でも縛る。
 */

const A: Ctx = { tenantId: "in-memory-cas-purged-a" };
const B: Ctx = { tenantId: "in-memory-cas-purged-b" };
let counter = 0;

function newMemory(ctx: Ctx, overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) {
  counter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: `本文 ${counter}`,
    contentHash: `in-memory-cas-purged-${counter}`,
    ...overrides,
  });
}

function ev(memoryId: MemoryId | null): NewMemoryEvent {
  return {
    tenantId: "ignored",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: { probe: true },
  };
}

async function makePurged() {
  const store = new InMemoryMemoryStore();
  const m = await store.createMemory(A, newMemory(A, { status: "forgotten" }));
  await store.purgeMemory(
    A,
    m.id,
    { content: "[purged]", digest: "[purged]" },
    {
      tenantId: A.tenantId,
      memoryId: m.id,
      kind: "purged",
      at: new Date("2026-06-01T00:00:00.000Z"),
      actor: { type: "system" },
      digestSnapshot: "要旨",
      meta: {},
    },
  );
  const row = await store.get(A, m.id);
  expect(row?.status).toBe("forgotten");
  expect(row?.purgedAt).toBeInstanceOf(Date);
  return { store, m };
}

describe("InMemoryMemoryStore の CAS は purge 済みの行を弾く（ADR 0549）", () => {
  it("updateStatus: expectedStatus 'forgotten' でも MemoryStatusConflictError。行は変わらない", async () => {
    const { store, m } = await makePurged();
    const before = await store.get(A, m.id);
    const error = await store
      .updateStatus(A, m.id, "active", { expectedStatus: "forgotten" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    const after = await store.get(A, m.id);
    expect(after?.status).toBe("forgotten");
    expect(after?.purgedAt).toEqual(before?.purgedAt);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("updateStatusWithEvent: 同じく弾く。イベントは積まれない", async () => {
    const { store, m } = await makePurged();
    const total = store.events.length;
    const error = await store
      .updateStatusWithEvent(A, m.id, "active", { expectedStatus: "forgotten" }, ev(m.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStatusConflictError);
    expect((await store.get(A, m.id))?.status).toBe("forgotten");
    expect(store.events.length).toBe(total);
  });

  it("supersedeWithNewMemories: purge 済みの対象は conflicted に入る。status は変わらず、イベントも積まれない", async () => {
    const { store, m } = await makePurged();
    const total = store.events.length;
    const result = await store.supersedeWithNewMemories(
      A,
      [{ input: newMemory(A), jobKinds: [] }],
      [{ id: m.id, supersededByIndex: 0, expectedStatus: "forgotten", event: ev(m.id) }],
    );
    expect(result.conflicted).toEqual([{ id: m.id, observedStatus: "forgotten" }]);
    expect(result.superseded).toHaveLength(0);
    const after = await store.get(A, m.id);
    expect(after?.status).toBe("forgotten");
    expect(after?.supersededById ?? null).toBeNull();
    expect(store.events.length).toBe(total);
  });

  it("supersedeWithNewMemories の事前判定: 弾かれる purge 済みの対象のイベント先は検査しない（別テナントでも例外にならない）", async () => {
    const { store, m } = await makePurged();
    const other = await store.createMemory(B, newMemory(B));
    const total = store.events.length;
    const result = await store.supersedeWithNewMemories(
      A,
      [{ input: newMemory(A), jobKinds: [] }],
      [{ id: m.id, supersededByIndex: 0, expectedStatus: "forgotten", event: ev(other.id) }],
    );
    expect(result.conflicted).toEqual([{ id: m.id, observedStatus: "forgotten" }]);
    expect(store.events.length).toBe(total);
  });

  it("対照: purge していない forgotten の行は、expectedStatus 'forgotten' で通る", async () => {
    const store = new InMemoryMemoryStore();
    const m = await store.createMemory(A, newMemory(A, { status: "forgotten" }));
    const updated = await store.updateStatus(A, m.id, "active", { expectedStatus: "forgotten" });
    expect(updated.status).toBe("active");
  });
});
