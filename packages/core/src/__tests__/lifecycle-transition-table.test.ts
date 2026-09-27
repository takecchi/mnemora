import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import {
  DOC_ROW_LINKS,
  LIFECYCLE_COMBOS,
  LIFECYCLE_OPS,
  LIFECYCLE_STATES,
  LIFECYCLE_TABLE,
  REEXTRACT_NEW_MEMORY_FROM_FORGOTTEN_OBSERVATION,
  REEXTRACT_TABLE,
  type LifecycleKit,
  type ReextractOldState,
  parseLifecycleTable,
  runCell,
  runCombo,
  runReextractCell,
} from "./lifecycle-transition-table.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 記憶の状態遷移の期待値の表（`lifecycle-transition-table.ts`）を core Fake で走らせる。
 * **1マスが1本の `it`**——どれか1マスが食い違うと、そのマスの `it` だけが赤になる。
 * Postgres での同じ表は `packages/postgres/src/__tests__/lifecycle-transition-table.postgres.test.ts`。
 */

function fakeKit(): LifecycleKit {
  const stores = createFakeRuntimeStores();
  return {
    memoryStore: stores.memoryStore,
    eventStore: stores.eventStore,
    makeRuntime: (llmProvider: LLMProvider) =>
      createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider,
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      }),
  };
}

const CELLS = LIFECYCLE_STATES.flatMap((state) => LIFECYCLE_OPS.map((op) => [state, op] as const));

describe("状態遷移の表（core Fake）: 出発状態 × 操作", () => {
  it.each(CELLS)("%s × %s", async (state, op) => {
    expect(await runCell(fakeKit(), state, op)).toEqual(LIFECYCLE_TABLE[state][op]);
  });
});

describe("状態遷移の表（core Fake）: 2手・3手の組", () => {
  it.each(LIFECYCLE_COMBOS.map((c) => [c.label, c] as const))("%s", async (_label, combo) => {
    expect(await runCombo(fakeKit(), combo)).toEqual({
      outcomes: combo.expectedOutcomes,
      states: combo.expectedStates,
    });
  });
});

describe("状態遷移の表（core Fake）: reextract と、元の Observation 由来の古い Memory", () => {
  it.each(Object.keys(REEXTRACT_TABLE) as ReextractOldState[])(
    "古い Memory が %s",
    async (oldState) => {
      const observed = await runReextractCell(fakeKit(), oldState);
      const { newMemories, ...promised } = observed;
      expect(promised).toEqual(REEXTRACT_TABLE[oldState]);
      // 🔴 未決（Issue #1079）: forget / purge 済みの Observation から新しい Memory を作るかは
      // 約束が無い。決まったら `REEXTRACT_NEW_MEMORY_FROM_FORGOTTEN_OBSERVATION` の1か所だけを直す。
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

describe("状態遷移の表 と docs/memory-model.md §11 の表の結び目", () => {
  const markdown = readFileSync(
    fileURLToPath(new URL("../../../../docs/memory-model.md", import.meta.url)),
    "utf8",
  );
  const docRows = parseLifecycleTable(markdown);

  it.each(DOC_ROW_LINKS.map((l) => [l.row, l] as const))(
    "§11 行%i の遷移とイベントが、表の対応するマスと一致する",
    (row, link) => {
      const doc = docRows.get(row);
      expect(doc, `§11 に行${row}が見つからない`).toBeDefined();
      const cell = LIFECYCLE_TABLE[link.state][link.op];
      // 遷移の左辺: 「任意」以外は出発状態と一致する。
      if (doc!.from !== "任意") {
        expect(doc!.from).toBe(link.state);
      }
      // 遷移の右辺: x（または相手）の結果の状態のどれかに含まれる。
      const resulting = [cell.x, cell.partner?.state].filter((s) => s !== undefined);
      for (const to of doc!.to) {
        expect(resulting, `§11 行${row}の右辺 ${to}`).toContain(to);
      }
      // 残るイベント: x（または相手）に積まれたイベントの kind のどれかに含まれる。
      const kinds = [...cell.events, ...(cell.partner?.events ?? [])].map((e) => e.split(":")[0]);
      expect(doc!.events.length, `§11 行${row}のイベント列が読めない`).toBeGreaterThan(0);
      for (const event of doc!.events.filter((e) =>
        /^(created|updated|superseded|archived|forgotten|purged|restored|unsuperseded)$/.test(e),
      )) {
        expect(kinds, `§11 行${row}のイベント ${event}`).toContain(event);
      }
    },
  );
});
