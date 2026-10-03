import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * ADR 0586（M24 の対）: `supersedeWithNewMemories` が置き換える古い記憶の `updatedAt` は壁時計であり、`opts.now` ではない
 * （ADR 0566 A）。core の Fake と同じ約束を、`InMemoryMemoryStore` にも当てる（core のテストは testkit を import できない）。
 */

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
    // outbox 行の時刻は opts.now のまま（陽性対照）。
    expect(result.created[0]!.jobs[0]!.createdAt).toEqual(PAST);
  });
});
