import { afterAll, describe, expect, it } from "vitest";
import type { RecallResult } from "@mnemora/core";
import { DEFAULT_RECALL_LIMIT } from "@mnemora/core";
import { runBudgetDemo, TINY_BUDGET_CHARS } from "../budget-demo.js";
import { runComparison } from "../compare.js";
import {
  DEFAULT_MNEMORA_PATH_ASSOCIATION,
  ingestConversation,
  runMnemoraPath,
} from "../mnemora-path.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { buildConversation } from "../scenario.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 連想枠が働く規模は、limit の外に連想の候補が maxCount 以上残る会話長（filler 20組 = 42 ターンで、スコープ内21件）。
 * 連想枠の既定は core 側でも on なので、「渡し方」ではなく「記憶が実際に連想で返ること」を見る。
 */
const FILLER_PAIRS = 20;

function associationCount(recall: RecallResult): number {
  return recall.memories.filter((m) => m.retrievedVia === "association").length;
}

function hasAssociationStage(recall: RecallResult): boolean {
  return recall.explain.stages.some((s) => s.stage === "association");
}

async function withRuntime<T>(
  body: (handle: Awaited<ReturnType<typeof createExampleRuntime>>) => Promise<T>,
): Promise<T> {
  await resetTestDatabase();
  await getTestClient();
  const handle = await createExampleRuntime(requireDatabaseUrl(), {});
  try {
    return await body(handle);
  } finally {
    await handle.close();
  }
}

describe("examples/chat の想起経路は、連想枠を既定で使う", () => {
  it("compare の行は、association を渡さなければ既定の maxCount ぶん連想で返す", async () => {
    await withRuntime(async (handle) => {
      const [row] = await runComparison(handle.runtime, {
        fillerPairsSequence: [FILLER_PAIRS],
        tenantPrefix: "assoc-default-compare",
        memoryStore: handle.memoryStore,
      });
      expect(row?.associationRows).toBe(DEFAULT_MNEMORA_PATH_ASSOCIATION.maxCount);
      expect(row?.returnedCount).toBe(
        DEFAULT_RECALL_LIMIT + DEFAULT_MNEMORA_PATH_ASSOCIATION.maxCount,
      );
    });
  });

  it("compare に association を渡すと、既定ではなくその値で働く（null は連想なし、{ maxCount: 3 } は3件）", async () => {
    await withRuntime(async (handle) => {
      const [off] = await runComparison(handle.runtime, {
        fillerPairsSequence: [FILLER_PAIRS],
        tenantPrefix: "assoc-override-null",
        memoryStore: handle.memoryStore,
        association: null,
      });
      const [three] = await runComparison(handle.runtime, {
        fillerPairsSequence: [FILLER_PAIRS],
        tenantPrefix: "assoc-override-three",
        memoryStore: handle.memoryStore,
        association: { maxCount: 3 },
      });
      expect(off?.associationRows).toBe(0);
      expect(off?.returnedCount).toBe(DEFAULT_RECALL_LIMIT);
      expect(three?.associationRows).toBe(3);
      expect(three?.returnedCount).toBe(DEFAULT_RECALL_LIMIT + 3);
    });
  });

  it("runMnemoraPath は association と budget を想起段へ渡す", async () => {
    await withRuntime(async (handle) => {
      const conversation = buildConversation(FILLER_PAIRS);
      const run = (tenant: string, opts: Parameters<typeof runMnemoraPath>[3]) =>
        runMnemoraPath(handle.runtime, { tenantId: `assoc-path-${tenant}` }, conversation, opts);

      const byDefault = await run("default", {});
      const off = await run("null", { association: null });
      const three = await run("three", { association: { maxCount: 3 } });
      const budgeted = await run("budget", { budget: { maxMemoryChars: TINY_BUDGET_CHARS } });

      expect(associationCount(byDefault.recall)).toBe(DEFAULT_MNEMORA_PATH_ASSOCIATION.maxCount);
      expect(associationCount(off.recall)).toBe(0);
      expect(hasAssociationStage(off.recall)).toBe(false);
      expect(associationCount(three.recall)).toBe(3);
      expect(budgeted.recall.omitted.some((o) => o.kind === "budget_dropped")).toBe(true);
      expect(hasAssociationStage(budgeted.recall)).toBe(true);
    });
  });

  it("budget-demo は budget 有りでも無しでも連想の段を通る", async () => {
    await withRuntime(async (handle) => {
      const ctx = { tenantId: "assoc-budget-demo" };
      const conversation = buildConversation(FILLER_PAIRS);
      await ingestConversation(handle.runtime, ctx, conversation);

      const { withoutBudget, withBudget } = await runBudgetDemo(handle.runtime, ctx, conversation);

      expect(associationCount(withoutBudget)).toBe(DEFAULT_MNEMORA_PATH_ASSOCIATION.maxCount);
      expect(hasAssociationStage(withoutBudget)).toBe(true);
      expect(hasAssociationStage(withBudget)).toBe(true);
    });
  });
});

afterAll(async () => {
  await closeTestClient();
});
