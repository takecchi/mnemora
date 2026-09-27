import { afterAll, describe, expect, it } from "vitest";
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
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 記憶の状態遷移の期待値の表（`packages/core/src/__tests__/lifecycle-transition-table.ts`）を
 * 本物の Postgres で走らせる。**表は core と同じ1つ**——core Fake の同じ歯は
 * `packages/core/src/__tests__/lifecycle-transition-table.test.ts`。1マスが1本の `it`。
 * `docs/memory-model.md` §11 との結び目は core 側にだけ置いている（表が1つなので、1回で足りる）。
 */

async function postgresKit(): Promise<LifecycleKit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const eventStore = new PostgresEventStore(db);
  return {
    memoryStore,
    eventStore,
    makeRuntime: (llmProvider: LLMProvider) =>
      createRuntime({
        memoryStore,
        outboxStore: new PostgresOutboxStore(db),
        vectorStore: new PostgresVectorStore(db),
        eventStore,
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
        llmProvider,
        embeddingProvider: {
          space: TEST_EMBEDDING_SPACE,
          embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
        },
        hashContent: (content: string) => `sha256(${content})`,
      }),
  };
}

const CELLS = LIFECYCLE_STATES.flatMap((state) => LIFECYCLE_OPS.map((op) => [state, op] as const));

afterAll(async () => {
  await closeTestClient();
});

describe("状態遷移の表（Postgres）: 出発状態 × 操作", () => {
  it.each(CELLS)("%s × %s", async (state, op) => {
    expect(await runCell(await postgresKit(), state, op)).toEqual(LIFECYCLE_TABLE[state][op]);
  });
});

describe("状態遷移の表（Postgres）: 2手・3手の組", () => {
  it.each(LIFECYCLE_COMBOS.map((c) => [c.label, c] as const))("%s", async (_label, combo) => {
    expect(await runCombo(await postgresKit(), combo)).toEqual({
      outcomes: combo.expectedOutcomes,
      states: combo.expectedStates,
    });
  });
});

describe("状態遷移の表（Postgres）: reextract と、元の Observation 由来の古い Memory", () => {
  it.each(Object.keys(REEXTRACT_TABLE) as ReextractOldState[])(
    "古い Memory が %s",
    async (oldState) => {
      const observed = await runReextractCell(await postgresKit(), oldState);
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
