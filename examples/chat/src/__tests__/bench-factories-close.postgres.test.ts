import { afterAll, describe, expect, it } from "vitest";
import { createAnswerBenchRuntime } from "../answer-bench.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { createTimeWeightingBenchRuntime } from "../time-weighting-bench.js";
import { closeTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * #941 の確かめ直し（#1774）。`runtime-factory-close-idempotent.postgres.test.ts` は `createExampleRuntime` の
 * handle の `close()` だけを見ている。同じ形の薄いラッパー（`close: () => closePostgresClient(client)`）を
 * 持つ `createAnswerBenchRuntime`（`answer-bench.ts`）・`createTimeWeightingBenchRuntime`
 * （`time-weighting-bench.ts`）の handle も、`close()` を2回呼んで reject しない。
 *
 * （失敗時に `Pool` を閉じる約束（#937）は `factories-close-failure-keeps-original-error.postgres.test.ts` が見る。
 * `bench/association-scale-*.ts` の3つの `create*` は、export されておらず import すると `main()` が走るので、
 * この形では見られない。）
 */

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
