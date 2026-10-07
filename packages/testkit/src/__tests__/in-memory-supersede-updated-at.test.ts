import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "supersede-updated-at" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const WALL = new Date("2026-06-01T12:34:56.789Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryMemoryStore.supersedeWithNewMemories: 古い記憶の updatedAt は壁時計（ADR 0566 A）", () => {
  it("opts.now を過去に固定しても、置き換えられた記憶の updatedAt は壁時計（opts.now ではない）", async () => {
    const store = new InMemoryMemoryStore();
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "old-hash" }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL);
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: old.id as MemoryId,
      kind: "superseded",
      actor: { type: "system" },
      meta: { reason: "test" },
    };

    const result = await store.supersedeWithNewMemories(
      ctx,
      [
        {
          input: buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "new-hash" }),
          jobKinds: ["embed"],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event }],
      { now: PAST },
    );

    expect(result.superseded).toHaveLength(1);
    const after = (await store.get(ctx, old.id))!;
    expect(after.status).toBe("superseded");
    expect(after.updatedAt).toEqual(WALL);
    expect(result.created[0]!.jobs[0]!.createdAt).toEqual(PAST);
  });
});

describe("InMemoryMemoryStore.supersedeWithNewMemories: 古い記憶の createdAt は変わらない（core の Fake と同じ不変条件）", () => {
  it("置き換えで updatedAt は壁時計へ進むが、createdAt は作ったときのまま（後から書き換わらない）", async () => {
    const CREATED = new Date("2026-05-01T00:00:00.000Z");
    const store = new InMemoryMemoryStore();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CREATED);
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "old-hash-created-at" }),
    );
    expect(old.createdAt).toEqual(CREATED);
    vi.setSystemTime(WALL);
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: old.id as MemoryId,
      kind: "superseded",
      actor: { type: "system" },
      meta: { reason: "test" },
    };

    const result = await store.supersedeWithNewMemories(
      ctx,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: "new-hash-created-at",
          }),
          jobKinds: ["embed"],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event }],
    );

    expect(result.superseded).toHaveLength(1);
    const after = (await store.get(ctx, old.id))!;
    expect(after.status).toBe("superseded");
    expect(after.updatedAt).toEqual(WALL);
    expect(after.createdAt).toEqual(CREATED);
  });
});

describe("InMemoryMemoryStore.supersedeWithNewMemories: CAS で弾かれた行は updatedAt も createdAt も書き換わらない（ADR 0592。クローンの判断）", () => {
  it("expectedStatus が合わず conflicted に積まれた古い記憶は、置き換えの前後で updatedAt・createdAt が同じ", async () => {
    const CREATED = new Date("2026-05-01T00:00:00.000Z");
    const MID = new Date("2026-05-15T00:00:00.000Z");
    const store = new InMemoryMemoryStore();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CREATED);
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "old-hash-cas-conflict" }),
    );
    vi.setSystemTime(MID);
    await store.updateStatus(ctx, old.id, "archived");
    const before = (await store.get(ctx, old.id))!;
    expect(before.status).toBe("archived");
    expect(before.updatedAt).toEqual(MID);
    vi.setSystemTime(WALL);
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: old.id as MemoryId,
      kind: "superseded",
      actor: { type: "system" },
      meta: { reason: "test" },
    };

    const result = await store.supersedeWithNewMemories(
      ctx,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: "new-hash-cas-conflict",
          }),
          jobKinds: ["embed"],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event }],
    );

    expect(result.superseded).toEqual([]);
    expect(result.conflicted).toEqual([{ id: old.id, observedStatus: "archived" }]);
    const after = (await store.get(ctx, old.id))!;
    expect(after.status).toBe("archived");
    expect(after.updatedAt).toEqual(MID);
    expect(after.createdAt).toEqual(CREATED);
  });
});
