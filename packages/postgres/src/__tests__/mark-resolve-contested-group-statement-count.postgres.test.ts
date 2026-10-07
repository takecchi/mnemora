import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { MemoryId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";
import { insertRawMemory, newEvent } from "./contested-group-fixtures.js";

/** 固定するのは「N を変えても数が等しい」ことだけで、数そのもの（実装の細部で動く値）は固定しない。 */

async function countClientQueries(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    count += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return count;
}

async function statementCounts(n: number): Promise<{ mark: number; resolve: number }> {
  const tenantId = `stmt-count-${n}`;
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const store = new PostgresMemoryStore(db);
  const ids: MemoryId[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await insertRawMemory(pool, tenantId, `s${i}`, { validFrom: null, validUntil: null }));
  }
  const mark = await countClientQueries(async () => {
    await store.markContestedGroup(
      { tenantId },
      ids.map((id) => ({ id, event: newEvent(tenantId, id, "m") })),
    );
  });
  const resolve = await countClientQueries(async () => {
    await store.resolveContestedGroup(
      { tenantId },
      ids.map((id) => ({ id, status: "active" as const, event: newEvent(tenantId, id, "r") })),
    );
  });
  return { mark, resolve };
}

afterAll(async () => {
  await closeTestClient();
});

describe("markContestedGroup / resolveContestedGroup: 文の数は N に依らない", () => {
  it("N=3 / 10 / 30 で mark の文の数が等しい", async () => {
    const counts = [];
    for (const n of [3, 10, 30]) counts.push((await statementCounts(n)).mark);
    expect(new Set(counts).size, `mark の文の数 (N=3,10,30): ${counts.join(",")}`).toBe(1);
  });

  it("N=3 / 10 / 30 で resolve の文の数が等しい", async () => {
    const counts = [];
    for (const n of [3, 10, 30]) counts.push((await statementCounts(n)).resolve);
    expect(new Set(counts).size, `resolve の文の数 (N=3,10,30): ${counts.join(",")}`).toBe(1);
  });
});
