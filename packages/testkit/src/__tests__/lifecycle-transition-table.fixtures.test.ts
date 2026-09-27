import { describe, expect, it } from "vitest";
import type { LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  LIFECYCLE_COMBOS,
  LIFECYCLE_OPS,
  LIFECYCLE_STATES,
  LIFECYCLE_TABLE,
  REEXTRACT_NEW_MEMORY_FROM_FORGOTTEN_OBSERVATION,
  REEXTRACT_TABLE,
  type LifecycleKit,
  type ReextractOldState,
  runCell,
  runCombo,
  runReextractCell,
} from "../../../core/src/__tests__/lifecycle-transition-table.js";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "../fixtures.js";

/**
 * 記憶の状態遷移の期待値の表（`packages/core/src/__tests__/lifecycle-transition-table.ts`）を、
 * `@mnemora/testkit/fixtures` の InMemory で走らせる。**表は core と同じ1つ**——core Fake の歯は
 * `packages/core/src/__tests__/lifecycle-transition-table.test.ts`、Postgres の歯は
 * `packages/postgres/src/__tests__/lifecycle-transition-table.postgres.test.ts`。1マスが1本の `it`。
 * 利用者が自分のテストで使う公開の fixture が、同じ表どおりに動くことを縛る。
 */

function fixtureKit(): LifecycleKit {
  const memoryStore = new InMemoryMemoryStore();
  const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
  return {
    memoryStore,
    eventStore,
    makeRuntime: (llmProvider: LLMProvider) =>
      createRuntime({
        memoryStore,
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        vectorStore: new InMemoryVectorStore(memoryStore),
        eventStore,
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        llmProvider,
        embeddingProvider: {
          space: { provider: "test", model: "lifecycle", dimensions: 3 },
          embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
        },
        hashContent: (content: string) => `sha256(${content})`,
      }),
  };
}

const CELLS = LIFECYCLE_STATES.flatMap((state) => LIFECYCLE_OPS.map((op) => [state, op] as const));

describe("状態遷移の表（testkit の fixture）: 出発状態 × 操作", () => {
  it.each(CELLS)("%s × %s", async (state, op) => {
    expect(await runCell(fixtureKit(), state, op)).toEqual(LIFECYCLE_TABLE[state][op]);
  });
});

describe("状態遷移の表（testkit の fixture）: 2手・3手の組", () => {
  it.each(LIFECYCLE_COMBOS.map((c) => [c.label, c] as const))("%s", async (_label, combo) => {
    expect(await runCombo(fixtureKit(), combo)).toEqual({
      outcomes: combo.expectedOutcomes,
      states: combo.expectedStates,
    });
  });
});

describe("状態遷移の表（testkit の fixture）: reextract と、元の Observation 由来の古い Memory", () => {
  it.each(Object.keys(REEXTRACT_TABLE) as ReextractOldState[])(
    "古い Memory が %s",
    async (oldState) => {
      const observed = await runReextractCell(fixtureKit(), oldState);
      const { newMemories, ...promised } = observed;
      expect(promised).toEqual(REEXTRACT_TABLE[oldState]);
      // 🔴 未決（Issue #1079）: core 側の同じ it の注記を参照。
      if (oldState === "forgotten" || oldState === "purged") {
        if (REEXTRACT_NEW_MEMORY_FROM_FORGOTTEN_OBSERVATION === "creates") {
          expect(newMemories).toBe(1);
        } else if (REEXTRACT_NEW_MEMORY_FROM_FORGOTTEN_OBSERVATION === "does_not_create") {
          expect(newMemories).toBe(0);
        }
      } else {
        expect(newMemories).toBe(1);
      }
    },
  );
});
