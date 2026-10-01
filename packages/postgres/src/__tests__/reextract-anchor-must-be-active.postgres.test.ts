import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
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
 * ADR 0454（穴探し30巡目）: `reextract` が `superseded` にした記憶の `supersededById`（置き換えた側）は、
 * 今回の抽出で **`active` な行**を指す。
 *
 * 抽出の冪等キー `(sourceObservationId, extractorVersion, contentHash)` は status を問わないので、候補が
 * 同じ Observation・同じ版の `superseded`／`archived` な既存行にぶつかると、`createMemoryWithOutbox`
 * 系はその行を `created: false` で返す。以前の実装は「候補列の先頭に対応する行」を無条件に置き換えた側にした
 * ため、次のことが起きていた（両実装・口あり／なしの両経路で同じ）。
 * - X → Y → X と LLM の出力が往復すると、Y が X に置き換えられ、X は Y に置き換えられたまま
 *   （循環。active が0件）。
 * - 先頭の候補が `archived` な既存行にぶつかると、別の active な記憶がその `archived` な行に置き換えられ、
 *   同じ呼び出しで作られた新しい active な記憶は誰も置き換えない。
 *
 * 直した後: 置き換えた側は、候補列のうち **`active` になる行**（新しく作る行・既に active な行）の先頭。
 * そういう候補が1件も無ければ、何も supersede しない。
 */

type Next = { contents: string[] };

function shared(next: Next) {
  const llmProvider: LLMProvider = {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      const extracted = req.schema.safeParse({
        memories: next.contents.map((content) => ({ content, provenanceKind: "stated" })),
      });
      return extracted.success ? extracted.data : req.schema.parse({ content: next.contents[0] });
    },
  };
  return {
    llmProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  };
}

interface Kit {
  /** 口（`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`）を持つ store の runtime。 */
  runtime: Runtime;
  /** 口を隠した store の runtime（2段の経路）。 */
  runtimeWithoutTx: Runtime;
  memoryStore: MemoryStore;
}

function withoutTxPorts(store: MemoryStore): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "supersedeWithNewMemories" || prop === "createMemoriesWithOutboxAndEvents") {
        return undefined;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const KITS: Array<[string, (next: Next) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (next) => {
      const memoryStore = new InMemoryMemoryStore();
      const deps = {
        ...shared(next),
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        vectorStore: new InMemoryVectorStore(memoryStore),
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      };
      return {
        memoryStore,
        runtime: createRuntime({ ...deps, memoryStore }),
        runtimeWithoutTx: createRuntime({ ...deps, memoryStore: withoutTxPorts(memoryStore) }),
      };
    },
  ],
  [
    "Postgres",
    async (next) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const deps = {
        ...shared(next),
        eventStore: new PostgresEventStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: new PostgresOutboxStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      };
      return {
        memoryStore,
        runtime: createRuntime({ ...deps, memoryStore }),
        runtimeWithoutTx: createRuntime({ ...deps, memoryStore: withoutTxPorts(memoryStore) }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "reextract-anchor-must-be-active" };

afterAll(async () => {
  await closeTestClient();
});

async function snapshot(kit: Kit, observationId: string) {
  const rows = await kit.memoryStore.listBySourceObservationAllVersions(ctx, observationId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return Object.fromEntries(
    rows.map((row) => [
      row.content,
      {
        status: row.status,
        by: row.supersededById ? (byId.get(row.supersededById)?.content ?? "?") : null,
      },
    ]),
  );
}

for (const [name, makeKit] of KITS) {
  for (const path of ["口あり", "口なし"] as const) {
    describe(`${name}（${path}）: reextract の置き換えた側は active な行である（ADR 0454）`, () => {
      async function start(contents: string[]) {
        const next: Next = { contents };
        const kit = await makeKit(next);
        const runtime = path === "口あり" ? kit.runtime : kit.runtimeWithoutTx;
        const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "u" });
        return { kit, next, runtime, first };
      }

      it("X → Y → X と出力が往復しても、Y は置き換えられない（循環・active 0件にならない）", async () => {
        const { kit, next, runtime, first } = await start(["X"]);
        next.contents = ["Y"];
        await runtime.reextract(ctx, first.observationId);
        next.contents = ["X"];

        const result = await runtime.reextract(ctx, first.observationId);

        expect(await snapshot(kit, first.observationId)).toEqual({
          X: { status: "superseded", by: "Y" },
          Y: { status: "active", by: null },
        });
        expect(result.supersededMemoryIds).toEqual([]);
        // 戻ってきた本文の行は既存の（superseded な）行で、skipped が理由を名乗る。
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ kind: "status_not_active", status: "superseded" }),
        );
      });

      it("archived な X と active な Z があり、出力が [X, W] なら、Z は新しい W に置き換えられる（X ではなく）", async () => {
        const { kit, next, runtime, first } = await start(["X", "Z"]);
        const rows = await kit.memoryStore.listBySourceObservationAllVersions(
          ctx,
          first.observationId,
        );
        const x = rows.find((row) => row.content === "X")!;
        await kit.memoryStore.updateStatus(ctx, x.id, "archived", { expectedStatus: "active" });
        next.contents = ["X", "W"];

        const result = await runtime.reextract(ctx, first.observationId);

        expect(await snapshot(kit, first.observationId)).toEqual({
          X: { status: "archived", by: null },
          W: { status: "active", by: null },
          Z: { status: "superseded", by: "W" },
        });
        expect(result.supersededMemoryIds).toHaveLength(1);
      });

      it("archived な X と active な Z があり、出力が [X] だけなら、Z は置き換えられない（置き換える active な行が無い）", async () => {
        const { kit, next, runtime, first } = await start(["X", "Z"]);
        const rows = await kit.memoryStore.listBySourceObservationAllVersions(
          ctx,
          first.observationId,
        );
        const x = rows.find((row) => row.content === "X")!;
        await kit.memoryStore.updateStatus(ctx, x.id, "archived", { expectedStatus: "active" });
        next.contents = ["X"];

        const result = await runtime.reextract(ctx, first.observationId);

        expect(await snapshot(kit, first.observationId)).toEqual({
          X: { status: "archived", by: null },
          Z: { status: "active", by: null },
        });
        expect(result.supersededMemoryIds).toEqual([]);
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ kind: "status_not_active", status: "archived" }),
        );
      });

      it("対照: 出力が [X, W] で X が active のままなら、今までどおり Z は先頭の X に置き換えられる", async () => {
        const { kit, next, runtime, first } = await start(["X", "Z"]);
        next.contents = ["X", "W"];

        const result = await runtime.reextract(ctx, first.observationId);

        expect(await snapshot(kit, first.observationId)).toEqual({
          X: { status: "active", by: null },
          W: { status: "active", by: null },
          Z: { status: "superseded", by: "X" },
        });
        expect(result.supersededMemoryIds).toHaveLength(1);
        expect(result.skipped).toContainEqual(expect.objectContaining({ kind: "unchanged" }));
      });

      it("対照: 出力が [W, X] なら、archived な X があっても今までどおり Z は先頭の W に置き換えられる", async () => {
        const { kit, next, runtime, first } = await start(["X", "Z"]);
        const rows = await kit.memoryStore.listBySourceObservationAllVersions(
          ctx,
          first.observationId,
        );
        const x = rows.find((row) => row.content === "X")!;
        await kit.memoryStore.updateStatus(ctx, x.id, "archived", { expectedStatus: "active" });
        next.contents = ["W", "X"];

        await runtime.reextract(ctx, first.observationId);

        expect((await snapshot(kit, first.observationId)).Z).toEqual({
          status: "superseded",
          by: "W",
        });
      });
    });
  }
}
