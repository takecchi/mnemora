import { afterAll, describe, expect, it } from "vitest";
import { createAnswerBenchRuntime } from "../answer-bench.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { createTimeWeightingBenchRuntime } from "../time-weighting-bench.js";
import { closeTestClient, requireDatabaseUrl } from "./test-db.js";

// bench/association-scale-*.ts の create* は、export されておらず import すると main() が走るので対象にしない。

const factories = [
  ["createExampleRuntime", createExampleRuntime],
  ["createAnswerBenchRuntime", createAnswerBenchRuntime],
  ["createTimeWeightingBenchRuntime", createTimeWeightingBenchRuntime],
] as const;

describe("examples/chat: ファクトリの handle（成功時は使える・close() は冪等）（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  for (const [name, create] of factories) {
    it(`${name}: 成功して返した handle は、close() するまで使える（成功時に Pool を閉じない）`, async () => {
      const handle = await create(requireDatabaseUrl(), {});
      try {
        const result = await handle.runtime.recall(
          { tenantId: "bench-factories-close-usable" },
          { text: "何か", scoreThreshold: -1000 },
        );
        expect(result.memories).toEqual([]);
      } finally {
        await handle.close();
      }
    });

    it(`${name}: 返した handle の close() は2回呼んでも reject しない`, async () => {
      const handle = await create(requireDatabaseUrl(), {});
      await handle.close();
      await expect(handle.close()).resolves.toBeUndefined();
    });
  }
});
