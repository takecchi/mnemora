import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * `reinforce` が `last_reinforced_at` / `decay_floor_at` を**巻き戻さない**ことを検査する
 * （ADR 0048）。
 *
 * `memory-store-update-status-concurrency.test.ts`（ADR 0030 の compare-and-swap）と
 * 同じ理由でプールを分ける——同一 `Pool` を共有すると、複数の論理的な「プロセス」を
 * 同じ接続の使い回しで模すことになり、本当に別セッションから同時に UPDATE が来た場合の
 * 競合を再現できない。
 *
 * ⚠ **この歯は「並行でしか壊れない」ものではない。**古い `at` を渡す呼び出しが1本でも
 * 混ざれば、直列でも巻き戻る。並行の歯は、それが実運用でどう起きるか（`runtime.observe` の
 * `memory_usage` が2本同時に走る）を示すために置いてある。
 */
describe("PostgresMemoryStore.reinforce は減衰の起点を巻き戻さない（ADR 0048）", () => {
  const pools: PostgresClient[] = [];
  const ctx: Ctx = { tenantId: "tenant-1" };

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
  });

  async function seed() {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
    const hour = 1000 * 60 * 60;
    return {
      store,
      memory,
      early: new Date(memory.recordedAt.getTime() + hour),
      late: new Date(memory.recordedAt.getTime() + 48 * hour),
    };
  }

  it("🔴 新しい at で強化したあと、古い at で強化しても起点は戻らない", async () => {
    const { store, memory, early, late } = await seed();

    const forward = await store.reinforce(ctx, memory.id, late);
    expect(forward.lastReinforcedAt?.getTime()).toBe(late.getTime());
    const floorAfterLate = forward.decayFloorAt.getTime();

    const backward = await store.reinforce(ctx, memory.id, early);

    // 返り値も、読み直した行も、両方で確かめる——返り値だけ整えて行が壊れている実装を通さない。
    expect(backward.lastReinforcedAt?.getTime()).toBe(late.getTime());
    expect(backward.decayFloorAt.getTime()).toBe(floorAfterLate);
    const reread = await store.get(ctx, memory.id);
    expect(reread?.lastReinforcedAt?.getTime()).toBe(late.getTime());
    expect(reread?.decayFloorAt.getTime()).toBe(floorAfterLate);
  });

  it("🔴 順方向（古い→新しい）はこれまでどおり動く", async () => {
    // ⚠ 発火しない側。巻き戻しを止める実装が「常に何も書かない」に退化していたら、
    // ここが赤くなる。
    const { store, memory, early, late } = await seed();

    const first = await store.reinforce(ctx, memory.id, early);
    expect(first.lastReinforcedAt?.getTime()).toBe(early.getTime());
    const floorAfterEarly = first.decayFloorAt.getTime();

    const second = await store.reinforce(ctx, memory.id, late);
    expect(second.lastReinforcedAt?.getTime()).toBe(late.getTime());
    // 起点が後ろへ動いたのだから、閾値を割る時刻も後ろへ動く。
    expect(second.decayFloorAt.getTime()).toBeGreaterThan(floorAfterEarly);
  });

  it("🔴 同じ at をもう一度渡すと、行そのものを触らない（updated_at も動かない）", async () => {
    // ⚠ ここが `<` と `<=` の境界である。`<=` にすると同じ値を書き直すので、
    // `last_reinforced_at` と `decay_floor_at` だけを見ていては**区別が付かない**。
    // 区別が付くのは `updated_at` だけ——「べき等」を「同じ値になる」ではなく
    // 「行を触らない」の意味で固定する。
    const { store, memory, late } = await seed();
    const first = await store.reinforce(ctx, memory.id, late);
    const again = await store.reinforce(ctx, memory.id, late);
    expect(again.lastReinforcedAt?.getTime()).toBe(late.getTime());
    expect(again.decayFloorAt.getTime()).toBe(first.decayFloorAt.getTime());
    expect(again.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("🔴 本物の並行: 4本が別々の at で同時に撃っても、行に残るのは最も新しい at である", async () => {
    const { memory } = await seed();
    const hour = 1000 * 60 * 60;
    const ats = [1, 48, 12, 24].map((h) => new Date(memory.recordedAt.getTime() + h * hour));
    const newest = ats.reduce((a, b) => (a.getTime() > b.getTime() ? a : b));

    const clients = ats.map(() => createPostgresClient(requireDatabaseUrl()));
    pools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.allSettled(
      stores.map((store, i) => store.reinforce(ctx, memory.id, ats[i]!)),
    );
    // 巻き戻しを止める実装は、古い側を**失敗にしない**（呼び出し側から見れば成功して、
    // 単に起点が動かないだけ）。⟹ 4本とも成功していること自体を先に確かめる。
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);

    const { db } = await getTestClient();
    const reread = await new PostgresMemoryStore(db).get(ctx, memory.id);
    expect(reread?.lastReinforcedAt?.getTime()).toBe(newest.getTime());
  });
});
