import { afterAll, describe, expect, it } from "vitest";
import { checkBackfillDemo, runBackfillDemo } from "../backfill.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `examples/chat/src/backfill.ts` の歯——`observe()` に `occurredAt` を渡すかどうかで
 * **同じ問い合わせが別の答えを返す**ことを、本物の Postgres に対して検査する（ADR 0037）。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装（`createExampleRuntime` に `env: {}` を
 * 渡し、`OPENAI_API_KEY` の有無に関わらず deterministic モードを強制する。
 * `scope.postgres.test.ts` と同じ規約）。DB は擬似物で代替しない。
 *
 * **⚠ 何を検査していて、何を検査していないか:**
 *
 * - 検査している: 「`occurredAt` を渡すと period の絞りが*出来事の時刻*に効く」
 *   「渡さないと*取り込んだ時刻*に落ちて、同じ絞りが効かない」という**構造**の性質。
 *   period フィルタは `effectiveTime = occurredAt ?? recordedAt` の比較だけで決まり、
 *   similarity の値に依存しないため、擬似 embedding でも決定的に成り立つ。
 * - 検査していない: 順位・スコアの質。それは `retrieval` の領分である。
 * - **⚠ 「古いほうが落ちた」が period 由来であることを名指しで確かめる**——
 *   `below_threshold` で落ちていないことを見る。日数は既定の半減期（30日）に対して
 *   小さく取ってあり（`BACKFILL_OLD_DAYS` の doc 参照）、閾値では落ちない位置にある。
 */
describe("examples/chat: backfill（observe() の occurredAt、本物の Postgres）", () => {
  it("occurredAt を渡すと、cutoff より古い出来事が落ち、理由が period として出る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const result = await runBackfillDemo(handle.runtime, {
        withOccurredAt: "example-chat-backfill-test-with",
        withoutOccurredAt: "example-chat-backfill-test-without",
      });
      const check = checkBackfillDemo(result);

      // 前提: そもそも何かが返っていること（0件なら「古いのが落ちた」は無意味な緑）。
      expect(result.withOccurredAt.memories.length).toBeGreaterThan(0);

      expect(check.withOccurredAtKeepsRecent).toBe(true);
      expect(check.withOccurredAtDropsOld).toBe(true);
      expect(check.withOccurredAtReportsPeriod).toBe(true);
      // ⚠ 閾値で落ちたのではないことを名指しで確かめる。
      expect(result.withOccurredAt.omitted.some((o) => o.kind === "below_threshold")).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("⚠ 対照: occurredAt を渡さないと、同じ問い合わせで古い出来事も残る（絞りが効かない）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runBackfillDemo(handle.runtime, {
        withOccurredAt: "example-chat-backfill-test-ctrl-with",
        withoutOccurredAt: "example-chat-backfill-test-ctrl-without",
      });
      const check = checkBackfillDemo(result);

      expect(check.withoutOccurredAtKeepsOld).toBe(true);
      expect(check.withoutOccurredAtReportsNothing).toBe(true);
      // 同じ問い合わせなのに、渡さない側のほうが多く返る——この差そのものが欠陥である。
      expect(result.withoutOccurredAt.memories.length).toBeGreaterThan(
        result.withOccurredAt.memories.length,
      );
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
