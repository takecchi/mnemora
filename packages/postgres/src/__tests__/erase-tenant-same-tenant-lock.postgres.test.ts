import { afterAll, describe, expect, it } from "vitest";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { eraseTenantLockKey } from "../erase-tenant-lock.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 既存の歯（同じテナントを2つの pool から同時に消す）は、競合が起きるかどうかが運に頼るうえ、`memoryStore` の lock しか見ていない。
 * ここでは、テスト側が先にそのテナントの lock を握り、各 port の `eraseTenant` がその間は終わらないこと、
 * 別のテナントの `eraseTenant` は待たされないことを、決まった順で見る。
 */

afterAll(async () => {
  await closeTestClient();
});

const VICTIM = "same-tenant-lock-victim";
const BYSTANDER = "same-tenant-lock-bystander";

/** `p` が `ms` のうちに決着した（resolve/reject どちらでも）か。 */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

type Port = "memoryStore" | "vectorStore" | "outboxStore";

describe("eraseTenant の各 port は、同じテナントの lock を待ち、別のテナントの lock は待たない", () => {
  for (const port of ["memoryStore", "vectorStore", "outboxStore"] as const satisfies Port[]) {
    it(`${port}: そのテナントの lock が握られている間は終わらず、別のテナントは待たされず、離すと終わる`, async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      const stores = {
        memoryStore: new PostgresMemoryStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: new PostgresOutboxStore(db),
      };
      const erase = (tenantId: string): Promise<unknown> =>
        stores[port].eraseTenant({ tenantId }, { limit: 10 });

      const holder = await pool.connect();
      let holding = false;
      let victim: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        holding = true;
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          eraseTenantLockKey(VICTIM).toString(),
        ]);

        victim = erase(VICTIM);
        expect(await settlesWithin(erase(BYSTANDER), 10_000)).toBe(true);
        expect(await settlesWithin(victim, 500)).toBe(false);

        await holder.query("COMMIT");
        holding = false;
        expect(await settlesWithin(victim, 10_000)).toBe(true);
      } finally {
        if (holding) {
          await holder.query("ROLLBACK");
        }
        holder.release();
        await victim?.catch(() => undefined);
      }
    }, 60_000);
  }
});
