import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord, OutboxStore } from "@mnemora/core";
import { InMemoryOutboxStore } from "@mnemora/testkit/fixtures";
import { PostgresOutboxStore } from "../outbox-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * outbox の `claimBatch`・`complete`・`fail` は、`tenantId` を正規化せず完全一致で比べる。2実装に同じ入力を流す。
 *
 * 出所: `packages/core/src/ctx.ts` の `Ctx` の TSDoc。「識別子は正規化せず、完全一致で比べる。大文字小文字…前後の空白が違えば
 * 別の値として扱う」「store はこの値で行を分ける」。
 *
 * - (a) 前後の空白だけが違うテナント（前・後ろ・両方の3組）は別のテナントである。互いのジョブを `claimBatch` で返さず、
 *   相手の綴りの ctx からは、同じ id と attempts を渡しても `complete`・`fail` が終端を付けない（リースが切れた後に、持ち主が取り直せる）。
 * - (b) 大文字を含むテナントが持ち主のジョブには、自分の綴りから `complete`・`fail` が届く（完全一致を「締めすぎ」て届かなくならない）。
 *
 * 既存の suite（`outbox-store-conformance.ts`）は、大文字小文字だけが違う組は縛るが、空白だけが違う組と、
 * 大文字を含むテナントでの終端の到達は縛っていなかった（Issue #1939）。
 */

const LEASE_MS = 60_000;

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  store: OutboxStore;
  seed(ctx: Ctx): Promise<string>;
  peek(jobId: string): Promise<{ completedAt: Date | null; failedAt: Date | null }>;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { pool, db } = await getTestClient();
  return {
    store: new PostgresOutboxStore(db),
    seed: async (ctx) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
         VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
         RETURNING id`,
        [ctx.tenantId],
      );
      return r.rows[0]!.id;
    },
    peek: async (jobId) => {
      const r = await pool.query<{ completed_at: Date | null; failed_at: Date | null }>(
        `SELECT completed_at, failed_at FROM outbox WHERE id = $1`,
        [jobId],
      );
      return { completedAt: r.rows[0]!.completed_at, failedAt: r.rows[0]!.failed_at };
    },
  };
}

async function inMemoryKit(): Promise<Kit> {
  const jobs: OutboxJobRecord[] = [];
  return {
    store: new InMemoryOutboxStore(jobs),
    seed: async (ctx) => {
      const id = randomUUID();
      jobs.push({
        id,
        tenantId: ctx.tenantId,
        kind: "embed",
        payload: {},
        availableAt: new Date(0),
        attempts: 0,
        createdAt: new Date(0),
      });
      return id;
    },
    peek: async (jobId) => {
      const job = jobs.find((j) => j.id === jobId)!;
      return { completedAt: job.completedAt ?? null, failedAt: job.failedAt ?? null };
    },
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", inMemoryKit],
  ["Postgres", postgresKit],
];

// 行は DB の `now()` で入れるので、Node 側の now を少し先にして claim を確実にする。
const claimNow = () => new Date(Date.now() + 5_000);
const afterLease = () => new Date(Date.now() + 5_000 + LEASE_MS + 1);

async function claimIds(kit: Kit, ctx: Ctx, now: Date, claimedBy: string): Promise<string[]> {
  const claimed = await kit.store.claimBatch(ctx, {
    limit: 100,
    now,
    claimedBy,
    leaseMs: LEASE_MS,
  });
  return claimed.map((j) => j.id);
}

async function claimAttempts(kit: Kit, ctx: Ctx, jobId: string): Promise<number> {
  const claimed = await kit.store.claimBatch(ctx, {
    limit: 100,
    now: claimNow(),
    claimedBy: "worker-a",
    leaseMs: LEASE_MS,
  });
  return claimed.find((j) => j.id === jobId)!.attempts;
}

const TERMINATORS: Array<
  [string, (kit: Kit, ctx: Ctx, id: string, attempts: number) => Promise<void>]
> = [
  ["complete", (kit, ctx, id, attempts) => kit.store.complete(ctx, id, attempts)],
  ["fail", (kit, ctx, id, attempts) => kit.store.fail(ctx, id, "boom", attempts)],
];

const BASE = "tenant-ws";
const WHITESPACE_PAIRS: Array<[string, string]> = [
  ["前の空白", " tenant-ws"],
  ["後ろの空白", "tenant-ws "],
  ["前後の空白", " tenant-ws "],
];

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: outbox の tenantId は完全一致で比べる（Ctx の TSDoc）`, () => {
    describe.each(WHITESPACE_PAIRS)("(a) 基準 %s だけが違うテナント", (_label, variant) => {
      const base: Ctx = { tenantId: BASE };
      const other: Ctx = { tenantId: variant };

      it("claimBatch: 互いのジョブを返さず、自分の綴りのジョブは返す", async () => {
        const kit = await makeKit();
        const baseJob = await kit.seed(base);
        const otherJob = await kit.seed(other);

        expect(await claimIds(kit, base, claimNow(), "w-base")).toEqual([baseJob]);
        expect(await claimIds(kit, other, claimNow(), "w-other")).toEqual([otherJob]);
      });

      it.each(TERMINATORS)(
        "%s: 相手の綴りの ctx からは、同じ id と attempts を渡しても終端を付けない（両方向）",
        async (_name, terminate) => {
          for (const [owner, stranger] of [
            [base, other],
            [other, base],
          ] as const) {
            const kit = await makeKit();
            const jobId = await kit.seed(owner);
            const attempts = await claimAttempts(kit, owner, jobId);

            await expect(terminate(kit, stranger, jobId, attempts)).resolves.toBeUndefined();

            expect(await kit.peek(jobId)).toEqual({ completedAt: null, failedAt: null });
            const reclaimed = await claimIds(kit, owner, afterLease(), "worker-a2");
            expect(reclaimed).toContain(jobId);
          }
        },
      );
    });

    describe("(b) 大文字を含むテナントが持ち主のジョブに、自分の綴りから終端が届く", () => {
      const owner: Ctx = { tenantId: "Tenant-Case" };

      it.each(TERMINATORS)(
        "%s: 終端が付き、リースが切れた後の claimBatch がそのジョブを返さない",
        async (name, terminate) => {
          const kit = await makeKit();
          const jobId = await kit.seed(owner);
          const attempts = await claimAttempts(kit, owner, jobId);

          await terminate(kit, owner, jobId, attempts);

          const row = await kit.peek(jobId);
          if (name === "complete") {
            expect(row.completedAt).toBeInstanceOf(Date);
            expect(row.failedAt).toBeNull();
          } else {
            expect(row.failedAt).toBeInstanceOf(Date);
            expect(row.completedAt).toBeNull();
          }
          expect(await claimIds(kit, owner, afterLease(), "worker-a2")).not.toContain(jobId);
        },
      );
    });
  });
}
