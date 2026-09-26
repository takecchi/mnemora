import { afterAll, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { requireDatabaseUrl } from "./test-db.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";

// `scale-bench-close-on-throw.postgres.test.ts` と同じ理由で、`main()` を止めてから
// dynamic import する。
process.env.MNEMORA_SCALE_BENCH_SKIP_MAIN = "1";
const { createScaleDatabase, teardownScaleDatabase, seedMemories, seedVectors } =
  await import("../bench/scale-bench.js");

/**
 * Issue #1005: `seedVectors` の `ARRAY(SELECT random() ...)` が外側の行を参照して
 * いないと、PostgreSQL はそれを InitPlan として1回だけ評価し、全行に同じベクトルを
 * 入れる。行ごとに別のベクトルが入ることを見る。
 */
describe("scale-bench: seedVectors は行ごとに別のベクトルを入れる（Issue #1005、本物の Postgres）", () => {
  const database = "mnemora_scale_bench_seed_vectors_test";
  let handle: Awaited<ReturnType<typeof createScaleDatabase>> | undefined;

  afterAll(async () => {
    if (handle) {
      await teardownScaleDatabase(handle);
    }
  });

  it("200行を入れると、埋め込みは200通りになる", async () => {
    handle = await createScaleDatabase(requireDatabaseUrl(), database);
    const tenant = "scale-bench-seed-vectors-tenant";
    const rowCount = 200;
    const dimensions = 8;
    const space: EmbeddingSpaceId = {
      provider: "bench",
      model: `scale-bench-seed-vectors-dim${dimensions}`,
      dimensions,
    };
    const table = embeddingSpaceTableName(space);

    await seedMemories(handle.pool, tenant, rowCount, 4, 0.25);
    await registerEmbeddingSpace(handle.pool, space);
    await seedVectors(handle.pool, tenant, table, dimensions, -0.25);

    const { rows } = await handle.pool.query<{ total: string; distinct: string }>(
      `SELECT count(*)::text AS total, count(DISTINCT embedding::text)::text AS distinct FROM ${table}`,
    );
    expect(rows[0]?.total).toBe(String(rowCount));
    expect(rows[0]?.distinct).toBe(String(rowCount));
  });
});
