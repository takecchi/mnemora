import { afterAll, describe, expect, it } from "vitest";
import { runAnalyzeMemories } from "../migrate.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `runAnalyzeMemories` 自身が、書き込みと同じ強さのロック（ROW EXCLUSIVE）を持つ接続を待たずに終わる。
 * 生の `ANALYZE` を流す歯では、この関数が別の文（VACUUM FULL など、書き込みを止める文）に
 * 変わっても気づけない。
 */

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

describe("runAnalyzeMemories は書き込みを持つ接続を待たない", () => {
  it("memories に ROW EXCLUSIVE を持つトランザクションが開いたままでも、3秒以内に終わって表名を返す", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE memories IN ROW EXCLUSIVE MODE");
      const analyzing = runAnalyzeMemories(pool);
      expect(await settlesWithin(analyzing, 3000)).toBe(true);
      await expect(analyzing).resolves.toEqual({ table: "memories" });
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
  });
});
