import { afterAll, describe, expect, it } from "vitest";
import { checkBudgetDemo, runBudgetDemo, TINY_BUDGET_CHARS } from "../budget-demo.js";
import { ingestConversation } from "../mnemora-path.js";
import { buildConversation } from "../scenario.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// usage.chars は予算を締めても縮むとは限らない（押し出された Memory が目次帯に回り、目次帯の実費が伸びる。docs/recall.md §5）。
// なので chars ではなく、構造的に保証される byTier.digest を見る。
describe("examples/chat: budget-demo（budget あり/なし対比、本物の Postgres、Issue #306）", () => {
  it("budget を渡すと、memories tier（byTier.digest）が実際に減り、budget_dropped が出る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const ctx = { tenantId: "example-chat-budget-demo-test-shrink" };
      const conversation = buildConversation(8);
      await ingestConversation(handle.runtime, ctx, conversation);

      const result = await runBudgetDemo(handle.runtime, ctx, conversation);
      const check = checkBudgetDemo(result);

      expect(check.withoutBudgetIsNonEmpty).toBe(true);

      expect(result.withBudget.usage.byTier.digest).toBeLessThan(
        result.withoutBudget.usage.byTier.digest,
      );
      expect(check.withBudgetIsSmaller).toBe(true);
      expect(check.withBudgetHasDroppedOmission).toBe(true);
      expect(result.withBudget.omitted.find((o) => o.kind === "budget_dropped")).toMatchObject({
        kind: "budget_dropped",
      });
    } finally {
      await handle.close();
    }
  });

  it("予算未指定なら、隠れた既定上限で切られない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "example-chat-budget-demo-test-no-hidden-cap" };
      const conversation = buildConversation(8);
      await ingestConversation(handle.runtime, ctx, conversation);

      const result = await runBudgetDemo(handle.runtime, ctx, conversation);
      const check = checkBudgetDemo(result);

      expect(check.withoutBudgetHasNoBudgetDropped).toBe(true);
      expect(check.withoutBudgetHasNoAppliedTruncation).toBe(true);

      const trace = result.withoutBudget.explain.stages.find(
        (s) => s.stage === "budget_truncation",
      );
      expect(trace?.executed).toBe(true);
      expect(trace?.detail?.budgetApplied).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("budget あり: 切り詰め後の量（連想枠を含む memories tier 全体）が申告した予算の内側に収まる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "example-chat-budget-demo-test-fits" };
      const conversation = buildConversation(8);
      await ingestConversation(handle.runtime, ctx, conversation);

      const result = await runBudgetDemo(handle.runtime, ctx, conversation);
      const check = checkBudgetDemo(result);

      expect(result.withBudget.usage.byTier.digest).toBeLessThanOrEqual(TINY_BUDGET_CHARS);
      expect(check.withBudgetFitsDeclaredCharBudget).toBe(true);
      expect(result.withBudget.usage.budgetExceeded).toBe(false);
      expect(check.withBudgetIsNotExceeded).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
