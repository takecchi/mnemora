import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, OutboxStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryOutboxStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 終端に達しないまま止まり続ける job が `limit` 本以上あると、`claimBatch` は古い順の先頭で同じ job を
 * 取り続け、後ろの job に届かない（先頭詰まり）——`OutboxStore` の doc の 2026-09-27 追記に書いた
 * 今の振る舞いを、Postgres と testkit の fixture の両方で縛る（振る舞いは変えていない）。
 *
 * 「止まり続ける」は、claim した job に `complete` も `fail` も呼ばない（ワーカーがその job で毎回
 * 止まる）ことで作る。リースが切れるたびに次の `claimBatch` を呼ぶ。
 */

const ctx: Ctx = { tenantId: "outbox-head-of-line" };
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

/** `count` 本の embed job を積み、積んだ順に古い `available_at`（1秒ずつ新しくなる）を付ける。 */
async function enqueue(kit: Kit, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { jobs } = await kit.memoryStore.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `hol-${i}`,
        content: `hol-${i}`,
      }),
      ["embed"],
    );
    ids.push(jobs[0]!.id);
  }
  for (const [i, id] of ids.entries()) {
    await kit.setAvailableAt(id, new Date(T - 3_600_000 + i * 1000));
  }
  return ids;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 止まり続ける job による先頭詰まり（今の振る舞い）`, () => {
    it("最も古い3本が毎回止まると、limit 3 の claim はリース切れのたびに同じ3本だけを取り、後ろに届かない", async () => {
      const kit = await makeKit();
      const ids = await enqueue(kit, 10);
      const stuck = ids.slice(0, 3);
      let now = T;
      for (let round = 0; round < 5; round++) {
        const claimed = await kit.outboxStore.claimBatch(ctx, {
          limit: 3,
          now: new Date(now),
          claimedBy: `worker-${round}`,
          leaseMs: LEASE_MS,
        });
        expect(claimed.map((j) => j.id).sort()).toEqual([...stuck].sort());
        // 止まる: complete も fail も呼ばない。
        now += LEASE_MS * 2;
      }
    });

    it("止まった job がまだ claim 中（リースの内）のうちに別の claim が来れば、後ろの job に届く", async () => {
      const kit = await makeKit();
      const ids = await enqueue(kit, 10);
      await kit.outboxStore.claimBatch(ctx, {
        limit: 3,
        now: new Date(T),
        claimedBy: "a",
        leaseMs: LEASE_MS,
      });
      const next = await kit.outboxStore.claimBatch(ctx, {
        limit: 3,
        now: new Date(T + 1000),
        claimedBy: "b",
        leaseMs: LEASE_MS,
      });
      expect(next.map((j) => j.id).sort()).toEqual(ids.slice(3, 6).sort());
    });
  });
}
