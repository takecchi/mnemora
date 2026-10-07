import { afterAll, describe, expect, it } from "vitest";
import { runComparison } from "../compare.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

describe("examples/chat: runComparison（本物の Postgres）", () => {
  it("会話が長いほど naive は伸び続け、mnemora は既定の limit で頭打ちになる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [0, 30],
        tenantPrefix: "example-compare-test",
        memoryStore: handle.memoryStore,
      });

      expect(rows).toHaveLength(2);
      const [short, long] = rows;
      expect(short).toBeDefined();
      expect(long).toBeDefined();

      expect(long!.naiveChars).toBeGreaterThan(short!.naiveChars);
      expect(long!.naiveChars).not.toBe(short!.naiveChars);
      expect(long!.mnemoraChars).not.toBe(short!.mnemoraChars);

      expect(long!.mnemoraShareOfNaiveChars).toBeLessThan(short!.mnemoraShareOfNaiveChars);
    } finally {
      await handle.close();
    }
  });

  it("要素ごとに独立のテナントを使う——長い会話を測った後で短い会話を測っても、前の記憶を引きずらない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      // わざと「長い→短い」の順に並べる。昇順だと、テナントを使い回す退行を検出できない（短い方を先に測ると、後続の長い会話が増える側にしか動かない）。
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [20, 3],
        tenantPrefix: "example-compare-isolation-test",
        memoryStore: handle.memoryStore,
      });

      const [long, short] = rows;
      expect(long!.totalInScope).toBe(long!.fillerPairs + 1);
      expect(short!.totalInScope).toBe(short!.fillerPairs + 1);
    } finally {
      await handle.close();
    }
  });

  it("各行で使用報告が実際に行われ、recall_usages に returnedCount と同じ件数の行が入る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [0, 3, 10],
        tenantPrefix: "example-compare-usage-report-test",
        memoryStore: handle.memoryStore,
      });

      for (const row of rows) {
        expect(row.returnedCount).toBeGreaterThan(0);
        expect(row.memoryUsageReported).toBe(true);
      }

      const totalReturned = rows.reduce((sum, r) => sum + r.returnedCount, 0);
      const usageCount = await handle.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM recall_usages
         WHERE tenant_id LIKE 'example-compare-usage-report-test-%'`,
      );
      expect(Number(usageCount.rows[0]?.count ?? "0")).toBe(totalReturned);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
