import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import {
  DOC_ROW_LINKS,
  DOC_ROW_OBSERVATIONS,
  LIFECYCLE_COMBOS,
  LIFECYCLE_OPS,
  LIFECYCLE_STATES,
  LIFECYCLE_TABLE,
  REEXTRACT_TABLE,
  type LifecycleKit,
  type ReextractOldState,
  parseLifecycleTable,
  runCell,
  runCombo,
  runReextractCell,
} from "./lifecycle-transition-table.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

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
      expect(observed).toEqual(REEXTRACT_TABLE[oldState]);
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
      if (doc!.from !== "任意") {
        expect(doc!.from).toBe(link.state);
      }
      const resulting = [cell.x, cell.partner?.state].filter((s) => s !== undefined);
      for (const to of doc!.to) {
        expect(resulting, `§11 行${row}の右辺 ${to}`).toContain(to);
      }
      const kinds = [...cell.events, ...(cell.partner?.events ?? [])].map((e) => e.split(":")[0]);
      expect(doc!.events.length, `§11 行${row}のイベント列が読めない`).toBeGreaterThan(0);
      for (const event of doc!.events.filter((e) =>
        /^(created|updated|superseded|archived|forgotten|purged|restored|unsuperseded)$/.test(e),
      )) {
        expect(kinds, `§11 行${row}のイベント ${event}`).toContain(event);
      }
    },
  );

  // マスでは結べない行（新しく作られる Memory・掃除）を、別の観測で結ぶ。
  it.each(DOC_ROW_OBSERVATIONS.map((o) => [o.row, o] as const))(
    "§11 行%i の遷移の行き先とイベントが、観測した新しい Memory（または掃除）と一致する",
    async (row, observation) => {
      const doc = docRows.get(row);
      expect(doc, `§11 に行${row}が見つからない`).toBeDefined();
      const observed = await observation.run(fakeKit());
      if (observed.state !== null) {
        expect(doc!.final, `§11 行${row}の最後の行き先`).toContain(observed.state);
      }
      expect(observed.events.length, `行${row}で積まれたイベントが無い`).toBeGreaterThan(0);
      const documented = doc!.events.filter((e) =>
        /^(created|updated|superseded|archived|forgotten|purged|events_purged|restored|unsuperseded)$/.test(
          e,
        ),
      );
      expect(documented.length, `§11 行${row}のイベント列が読めない`).toBeGreaterThan(0);
      for (const event of documented) {
        expect(observed.events, `§11 行${row}のイベント ${event}`).toContain(event);
      }
    },
  );
});
