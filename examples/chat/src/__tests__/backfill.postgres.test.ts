import { afterAll, describe, expect, it } from "vitest";
import { checkBackfillDemo, runBackfillDemo } from "../backfill.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

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

      expect(result.withOccurredAt.memories.length).toBeGreaterThan(0);

      expect(check.withOccurredAtKeepsRecent).toBe(true);
      expect(check.withOccurredAtDropsOld).toBe(true);
      expect(check.withOccurredAtReportsPeriod).toBe(true);
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
