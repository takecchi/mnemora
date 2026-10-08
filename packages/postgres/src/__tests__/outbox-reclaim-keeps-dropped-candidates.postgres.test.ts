import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, OutboxStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryOutboxStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 取り直しで `availableAt` を `opts.now` へ書き直すのは、その `claimBatch` が実際に取り直した行だけである。リースが切れて
 * 取り直しの候補になっていても、`limit` で落ちた行の `availableAt` は変わらない（`OutboxStore` の TSDoc「取り直すときに限り」）。
 * どの行も `availableAt` を別々の時刻にして、同着の並び（約束されていない）に頼らずに見分ける。
 */

const ctx: Ctx = { tenantId: "outbox-reclaim-keeps-dropped-candidates" };
const T = Date.parse("2030-01-01T00:00:00.000Z");
const LEASE_MS = 60_000;

type Kit = {
  memoryStore: MemoryStore;
  outboxStore: OutboxStore;
  setAvailableAt: (jobId: string, at: Date) => Promise<void>;
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        setAvailableAt: async (jobId, at) => {
          memoryStore.outboxJobs.find((j) => j.id === jobId)!.availableAt = at;
        },
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      return {
        memoryStore: new PostgresMemoryStore(db),
        outboxStore: new PostgresOutboxStore(db),
        setAvailableAt: async (jobId, at) => {
          await pool.query("UPDATE outbox SET available_at = $2 WHERE id = $1", [jobId, at]);
        },
      };
    },
  ],
];

/** embed job を1本積み、`availableAt` を `at` にする。 */
async function enqueueAt(kit: Kit, i: number, at: Date): Promise<string> {
  const { jobs } = await kit.memoryStore.createMemoryWithOutbox(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `reclaim-dropped-${i}`,
      content: `reclaim-dropped-${i}`,
    }),
    ["embed"],
  );
  const id = jobs[0]!.id;
  await kit.setAvailableAt(id, at);
  return id;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: limit で落ちた取り直しの候補は availableAt を保つ`, () => {
    it("落ちた候補は、あとから積まれた job より前に取られる（書き直されて後ろへ回っていない）", async () => {
      const kit = await makeKit();
      // a・b・c は古い順に1秒ずつ。d は a〜c の初めての claim のあと、取り直しの時刻より前に取れるようになる。
      const a = await enqueueAt(kit, 0, new Date(T - 3_000));
      const b = await enqueueAt(kit, 1, new Date(T - 2_000));
      const c = await enqueueAt(kit, 2, new Date(T - 1_000));
      const d = await enqueueAt(kit, 3, new Date(T + LEASE_MS));

      const first = await kit.outboxStore.claimBatch(ctx, {
        limit: 3,
        now: new Date(T),
        claimedBy: "first",
        leaseMs: LEASE_MS,
      });
      expect(first.map((j) => j.id).sort()).toEqual([a, b, c].sort());

      // a・b・c のリースが切れた時刻。候補は a・b・c（取り直し）と d（初めて）で、limit 1 は最も古い a だけを取り直す。
      const reclaimAt = T + LEASE_MS * 2;
      const reclaimed = await kit.outboxStore.claimBatch(ctx, {
        limit: 1,
        now: new Date(reclaimAt),
        claimedBy: "reclaim",
        leaseMs: LEASE_MS,
      });
      expect(reclaimed.map((j) => j.id)).toEqual([a]);
      expect(reclaimed[0]!.availableAt.getTime()).toBe(reclaimAt);

      // b・c が元の availableAt（T − 2000・T − 1000）を保っていれば、d（T + LEASE_MS）より先に取られる。
      // 落ちた b・c まで reclaimAt へ書き直す実装では、d が先になる。
      const next = await kit.outboxStore.claimBatch(ctx, {
        limit: 2,
        now: new Date(reclaimAt + 1_000),
        claimedBy: "next",
        leaseMs: LEASE_MS,
      });
      expect(next.map((j) => j.id).sort()).toEqual([b, c].sort());

      const last = await kit.outboxStore.claimBatch(ctx, {
        limit: 1,
        now: new Date(reclaimAt + 2_000),
        claimedBy: "last",
        leaseMs: LEASE_MS,
      });
      expect(last.map((j) => j.id)).toEqual([d]);
    });
  });
}
