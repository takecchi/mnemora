import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { runAnalyzeMemories } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "analyze-memories-lock" };

/** `p` が `ms` のうちに決着したか。 */
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

afterAll(async () => {
  await closeTestClient();
});

describe("runAnalyzeMemories: ANALYZE のロックと書き込み（実測）", () => {
  it("ANALYZE は ShareUpdateExclusiveLock を取り、それを持つ間も別の接続から書き込める", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("ANALYZE memories");
      const { rows } = await holder.query<{ mode: string }>(
        "SELECT mode FROM pg_locks WHERE relation = 'memories'::regclass AND pid = pg_backend_pid()",
      );
      expect(rows.map((r) => r.mode)).toContain("ShareUpdateExclusiveLock");

      const write = memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "during-analyze",
          content: "書く",
        }),
      );
      expect(await settlesWithin(write, 3000)).toBe(true);
      await expect(write).resolves.toMatchObject({ contentHash: "during-analyze" });
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
  });

  it("何度呼んでも成功し、対象の表の名前を返す", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    expect(await runAnalyzeMemories(pool)).toEqual({ table: "memories" });
    expect(await runAnalyzeMemories(pool)).toEqual({ table: "memories" });
  });
});
