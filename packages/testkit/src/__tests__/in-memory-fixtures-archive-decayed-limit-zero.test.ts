// クローンの委譲先が書いた回帰テスト。オーナーではない（ADR 0432 AL-4）。
//
// `archiveDecayed` の `reachedLimit` は `archived.length === opts.limit` だったので、
// `limit: 0` のときは対象が0件でも `true` になった。TSDoc（`MemoryStore.archiveDecayed`）は
// 「対象が0件なら `reachedLimit: false`」と書いている。`limit: 0` は断らない（Postgres の
// `LIMIT 0` は通るので、Fake も通す）——何も掃かず、「上限で打ち切った」とも言わない。
//
// `*-conformance.ts` には触れない（`in-memory-fixtures-archive-decayed-limit.test.ts` と同じ作法）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

describe("InMemoryMemoryStore.archiveDecayed: limit が 0 のとき reachedLimit は false（ADR 0432 AL-4）", () => {
  it("limit=0 は対象が在っても何も掃かず、reachedLimit: false を返す", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-zero" }),
    );

    const result = await store.archiveDecayed(ctx, { now: NOW, limit: 0 });

    expect(result).toEqual({ archived: [], reachedLimit: false });
    expect((await store.get(ctx, memory.id))?.status).toBe("active");
  });

  it("limit=0 で対象が0件でも reachedLimit: false", async () => {
    const store = new InMemoryMemoryStore();
    const result = await store.archiveDecayed(ctx, { now: NOW, limit: 0 });
    expect(result).toEqual({ archived: [], reachedLimit: false });
  });

  it("対照: limit=1 で1件掃いたら reachedLimit: true（正の limit の意味は変わらない）", async () => {
    const store = new InMemoryMemoryStore();
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-one" }),
    );
    const result = await store.archiveDecayed(ctx, { now: NOW, limit: 1 });
    expect(result.archived).toHaveLength(1);
    expect(result.reachedLimit).toBe(true);
  });
});
