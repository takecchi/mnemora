// ADR 0596: `createdAt` は作ったときのまま。`archiveDecayed` の後も `purgeMemory` の後も書き換わらない。
//
// **明文の約束はない**が、作成時刻が後から書き換わらないことを当然の不変条件として縛る、とクローンが判断した
// （supersede の `createdAt` を同じ判断で縛った ADR 0592 と同じ線）。
// Fake 側の同種の歯は `packages/core/src/__tests__/fake-event-time-nul-claim-controls.test.ts`、
// Postgres 側は `packages/postgres/src/__tests__/created-at-after-archive-purge.postgres.test.ts`。
// `*-conformance.ts` には触れない（既存の `in-memory-fixtures-*.test.ts` と同じ作法）。

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryMemoryStore: createdAt は archive・purge の後も作成時のまま（ADR 0596）", () => {
  it("archiveDecayed の後も、createdAt は作成時の値（updatedAt は進む）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new InMemoryMemoryStore();
    const now = new Date("2031-01-01T00:00:00.000Z");
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(createdAt);
    const created = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-created-archive",
        decayFloorAt: new Date(now.getTime() - 1_000),
      }),
    );
    expect(created.createdAt).toEqual(createdAt);

    vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    const result = await store.archiveDecayed(ctx, { now, limit: 10 });

    expect(result.archived.map((a) => a.memoryId)).toEqual([created.id]);
    const stored = await store.get(ctx, created.id);
    expect(stored?.status).toBe("archived");
    expect(stored!.updatedAt).toEqual(new Date("2030-01-02T00:00:00.000Z"));
    expect(stored!.createdAt).toEqual(createdAt);
  });

  it("purgeMemory の後も、createdAt は作成時の値（purgedAt は event.at、updatedAt は壁時計）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new InMemoryMemoryStore();
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(createdAt);
    const created = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-created-purge",
        status: "forgotten",
      }),
    );
    expect(created.createdAt).toEqual(createdAt);
    const at = new Date("2020-01-01T00:00:00.000Z");
    const event: NewMemoryEvent = {
      tenantId: ctx.tenantId,
      memoryId: created.id,
      kind: "purged",
      at,
      actor: { type: "system" },
      digestSnapshot: "要旨",
      meta: {},
    };

    vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    await store.purgeMemory(ctx, created.id, { content: "[purged]", digest: "[purged]" }, event);

    const stored = await store.get(ctx, created.id);
    expect(stored?.purgedAt).toEqual(at);
    expect(stored!.updatedAt).toEqual(new Date("2030-01-02T00:00:00.000Z"));
    expect(stored!.createdAt).toEqual(createdAt);
  });
});
