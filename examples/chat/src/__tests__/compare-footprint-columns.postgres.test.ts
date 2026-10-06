import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runComparison } from "../compare.js";
import {
  CALIBRATION_SAMPLE_DESIGN,
  generateCalibrationSamples,
} from "../recall-footprint-calibration-samples.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * recall-footprint の較正標本まわりの、本物の Postgres を使う歯（Issue #340・ADR 0314。Issue #1775 の #728 の
 * 変異6・11）。
 *
 * - 変異6: `runComparison` の各行の `bandEntryCount`（帯の件数）・`rawIndexJsonLength`（`index` の JSON 長）が、
 *   実測の値で入る（`footprintFieldsFromRecall` を通る）。2欄を 0 固定にしても、DB を使わない歯は見えない。
 * - 変異11: 較正標本の生成は `limit`（20）を渡して帯を空に保つ（較正は帯が空の標本しか使わない）。`limit` を渡さないと
 *   既定（10）になり、`fillerPairs` が大きい点で帯が出る。
 */

beforeEach(async () => {
  await resetTestDatabase();
  await getTestClient();
});

afterAll(async () => {
  await closeTestClient();
});

describe("examples/chat: runComparison の行の帯の件数と index の JSON 長（本物の Postgres）", () => {
  it("長い会話（既定の limit を超える）は bandEntryCount > 0、短い会話は 0。どちらも rawIndexJsonLength > 0", async () => {
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [0, 30],
        tenantPrefix: "example-compare-footprint-columns",
        memoryStore: handle.memoryStore,
      });

      const [short, long] = rows;
      expect(short!.bandEntryCount).toBe(0);
      expect(long!.bandEntryCount).toBeGreaterThan(0);
      expect(short!.rawIndexJsonLength).toBeGreaterThan(0);
      expect(long!.rawIndexJsonLength).toBeGreaterThan(short!.rawIndexJsonLength);
    } finally {
      await handle.close();
    }
  });
});

describe("examples/chat: 較正標本の生成は limit を渡して帯を空に保つ（本物の Postgres）", () => {
  it("設計の全点で、recallLimit が設計の limit と一致し、bandEntryCount が 0", async () => {
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await generateCalibrationSamples(handle.runtime);

      expect(rows).toHaveLength(CALIBRATION_SAMPLE_DESIGN.length);
      for (const [index, row] of rows.entries()) {
        const point = CALIBRATION_SAMPLE_DESIGN[index]!;
        expect(row.recallLimit, `fillerPairs=${point.fillerPairs}`).toBe(point.limit);
        expect(row.bandEntryCount, `fillerPairs=${point.fillerPairs}`).toBe(0);
        // 帯が空なら、返った件数が範囲内の件数と一致する。
        expect(row.returnedCount, `fillerPairs=${point.fillerPairs}`).toBe(row.totalInScope);
      }
    } finally {
      await handle.close();
    }
  });
});
