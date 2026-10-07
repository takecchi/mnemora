import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, OutboxStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryOutboxStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 取り直し（claim 時点で `claimed_at` が既に非 NULL＝リースが切れた行を再び claim する場合）は `available_at` を `opts.now` に書き直す。初めての claim（`claimed_at` が NULL だった行）では変えない。取る順（`available_at` の古い順）そのものは変えない。
 * 「止まり続ける」は、claim した job に `complete` も `fail` も呼ばない（ワーカーがその job で毎回止まる）ことで作る。リースが切れるたびに次の `claimBatch` を呼ぶ。
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
  describe(`${name}: 止まり続ける job による先頭詰まりの解消（取り直しは後ろへ回す）`, () => {
    it("最も古い3本が毎回止まると、1回目（初めての claim）と2回目（取り直し）は同じ3本を返すが、取り直しで availableAt が now に更新され、3回目以降は後ろの job に届く", async () => {
      const kit = await makeKit();
      const ids = await enqueue(kit, 10);
      const stuck = ids.slice(0, 3);
      let now = T;

      const round0 = await kit.outboxStore.claimBatch(ctx, {
        limit: 3,
        now: new Date(now),
        claimedBy: "worker-0",
        leaseMs: LEASE_MS,
      });
      expect(round0.map((j) => j.id).sort()).toEqual([...stuck].sort());
      for (const [i, id] of stuck.entries()) {
        const job = round0.find((j) => j.id === id)!;
        expect(job.availableAt.getTime()).toBe(T - 3_600_000 + i * 1000);
      }

      now += LEASE_MS * 2;
      const round1 = await kit.outboxStore.claimBatch(ctx, {
        limit: 3,
        now: new Date(now),
        claimedBy: "worker-1",
        leaseMs: LEASE_MS,
      });
      expect(round1.map((j) => j.id).sort()).toEqual([...stuck].sort());
      for (const job of round1) {
        expect(job.availableAt.getTime()).toBe(now);
      }

      now += LEASE_MS * 2;
      const round2 = await kit.outboxStore.claimBatch(ctx, {
        limit: 3,
        now: new Date(now),
        claimedBy: "worker-2",
        leaseMs: LEASE_MS,
      });
      expect(round2.map((j) => j.id).sort()).toEqual(ids.slice(3, 6).sort());
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

    it("止まり続ける job が limit 本あっても、有限回のラウンドで全 job が一度は claim される（飢餓しない）", async () => {
      const kit = await makeKit();
      const ids = await enqueue(kit, 10);
      const stuckSet = new Set(ids.slice(0, 3));
      const seen = new Set<string>();
      let now = T;
      const MAX_ROUNDS = 20;
      for (let round = 0; round < MAX_ROUNDS && seen.size < ids.length; round++) {
        const claimed = await kit.outboxStore.claimBatch(ctx, {
          limit: 3,
          now: new Date(now),
          claimedBy: `worker-${round}`,
          leaseMs: LEASE_MS,
        });
        for (const job of claimed) {
          seen.add(job.id);
          if (!stuckSet.has(job.id)) {
            await kit.outboxStore.complete(ctx, job.id, job.attempts);
          }
        }
        now += LEASE_MS * 2;
      }
      expect(seen.size).toBe(ids.length);
    });

    it("取り直し（リース切れの再 claim）では availableAt が opts.now になり、初めての claim では変えない", async () => {
      const kit = await makeKit();
      const ids = await enqueue(kit, 1);
      const original = T - 3_600_000;
      let now = T;

      const first = await kit.outboxStore.claimBatch(ctx, {
        limit: 1,
        now: new Date(now),
        claimedBy: "a",
        leaseMs: LEASE_MS,
      });
      expect(first.map((j) => j.id)).toEqual(ids);
      expect(first[0]!.availableAt.getTime()).toBe(original);

      now += LEASE_MS * 2;
      const second = await kit.outboxStore.claimBatch(ctx, {
        limit: 1,
        now: new Date(now),
        claimedBy: "b",
        leaseMs: LEASE_MS,
      });
      expect(second.map((j) => j.id)).toEqual(ids);
      expect(second[0]!.availableAt.getTime()).toBe(now);
    });
  });
}
