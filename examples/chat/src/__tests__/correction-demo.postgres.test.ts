import { afterAll, describe, expect, it } from "vitest";
import type { RecallRecordMemory } from "@mnemora/core";
import {
  checkCorrectionDemo,
  checkCorrectionOmission,
  runCorrectionDemo,
} from "../correction-demo.js";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import { requireMeasuredTotal } from "../recalled-score.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

describe("examples/chat: correction（markContested → resolveContested、本物の Postgres）", () => {
  it("markContested で対になった2件は recall で隣接して出て、resolveContested(supersede) 後は古いほうが消える", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");

      const result = await runCorrectionDemo(
        handle.runtime,
        { tenantId: "example-chat-correction-test" },
        CORRECTION_SCENARIO,
        { chosenExternalId: CORRECTION_SCENARIO.contestedPair.firstExternalId },
      );

      expect(result.outcome).toBe("resolved");
      expect(result.discovery.candidates.length).toBeGreaterThan(0);
      expect(result.chosenId).toBe(result.originalId);
      expect(result.chosenRecallRank).not.toBeNull();
      expect(result.discovery.candidates.some((c) => c.memoryId === result.originalId)).toBe(true);

      const check = checkCorrectionDemo(result);

      expect(result.markOutcomeKind).toBe("contested");
      expect(result.resolveOutcomeKind).toBe("resolved");
      expect(check.markSucceeded).toBe(true);
      expect(check.resolveSucceeded).toBe(true);

      expect(result.beforeMark!.memories.length).toBeGreaterThan(0);
      expect(check.afterMarkBothPresent).toBe(true);
      expect(check.afterMarkCompanionRetrieval).toBe(true);
      expect(check.afterMarkCompanionOfOther).toBe(true);

      expect(check.afterResolveOriginalAbsent).toBe(true);
      expect(check.afterResolveCorrectionPresent).toBe(true);
      expect(result.afterResolve!.memories.length).toBe(1);

      const omissionCheck = checkCorrectionOmission(result);
      expect(omissionCheck.afterResolveOriginalOmittedAsSuperseded).toBe(true);
      expect(result.afterResolve!.omitted).toContainEqual(
        expect.objectContaining({ kind: "filtered", condition: "superseded" }),
      );

      const ctx = { tenantId: "example-chat-correction-test" };
      const originalEvents = await handle.eventStore.list(ctx, { memoryId: result.originalId });
      expect(originalEvents.length).toBeGreaterThanOrEqual(2);
      const contestedEvent = originalEvents.find((e) => e.meta.reason === "contested");
      const resolvedEvent = originalEvents.find((e) => e.meta.reason === "contested_resolved");
      expect(contestedEvent).toBeDefined();
      expect(resolvedEvent).toBeDefined();

      for (const event of [contestedEvent, resolvedEvent]) {
        const note = event!.meta.note;
        expect(typeof note).toBe("string");
        expect(note as string).toContain(`recallId=${result.discovery.recallId}`);
        expect(note as string).toContain(`chosenRecallRank=${result.chosenRecallRank}`);
        expect(note as string).toContain(`candidates=${result.discovery.candidates.length}`);
        expect(note as string).toContain("winner=correcting");
      }

      const noteText = contestedEvent!.meta.note as string;
      const bridgedRecallId = /recallId=([^ /]+)/.exec(noteText)?.[1];
      expect(bridgedRecallId).toBe(result.discovery.recallId);
      const record = await handle.runtime.getRecall(ctx, bridgedRecallId!);
      expect(record).not.toBeNull();
      expect(Array.isArray(record!.explain.stages)).toBe(true);

      expect(record!.returnedMemories.breakdownCaptured).toBe(true);
      const chosenInRecall = record!.returnedMemories.memories.find(
        (m) => m.memoryId === result.chosenId,
      );
      expect(chosenInRecall).toBeDefined();
      expect(typeof requireMeasuredTotal((chosenInRecall as RecallRecordMemory).score)).toBe(
        "number",
      );
    } finally {
      await handle.close();
    }
  });

  it("choice を渡さない ⟹ outcome=awaiting_choice、書き込み0件(markContested/resolveContestedのどちらも呼ばれない)", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "example-chat-correction-test-no-choice" };
      const result = await runCorrectionDemo(handle.runtime, ctx);

      expect(result.outcome).toBe("awaiting_choice");
      expect(result.chosenId).toBeNull();
      expect(result.beforeMark).toBeNull();
      expect(result.afterMark).toBeNull();
      expect(result.afterResolve).toBeNull();

      expect(result.discovery.candidates.length).toBeGreaterThan(0);

      const recheck = await handle.runtime.recall(ctx, { text: result.scenario.query, limit: 10 });
      const recheckIds = recheck.memories.map((m) => m.memoryId).sort();
      expect(recheckIds).toEqual([result.originalId, result.correctionId].sort());
      expect(recheck.memories.every((m) => m.retrievedVia !== "mandatory_companion")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("宣言(contestedPair.winnerExternalId)を original 側にすると、original が生き残り correction が消える(順序規則ではないことの実測)", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const reversedScenario = {
        ...CORRECTION_SCENARIO,
        original: {
          ...CORRECTION_SCENARIO.original,
          externalId: "correction-demo-reversed-original",
        },
        correction: {
          ...CORRECTION_SCENARIO.correction,
          externalId: "correction-demo-reversed-correction",
        },
        contestedPair: {
          firstExternalId: "correction-demo-reversed-original",
          secondExternalId: "correction-demo-reversed-correction",
          winnerExternalId: "correction-demo-reversed-original",
        },
      };

      const result = await runCorrectionDemo(
        handle.runtime,
        { tenantId: "example-chat-correction-test-reversed" },
        reversedScenario,
        { chosenExternalId: reversedScenario.contestedPair.firstExternalId },
      );

      expect(result.outcome).toBe("resolved");
      expect(result.originalId).toBeDefined();
      const finalIds = result.afterResolve!.memories.map((m) => m.memoryId);
      expect(finalIds).toContain(result.originalId);
      expect(finalIds).not.toContain(result.correctionId);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
