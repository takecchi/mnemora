import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  MemoryId,
  MemoryStore,
  RecallQuery,
  RecallResult,
  Runtime,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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
 * recall の説明（`explain.stages`）が、実際に起きたことと合っていることを今の振る舞いのまま縛る。
 * `getRecall` の記録は返り値と一致する。Postgres の jsonb はキーの順を変えるので、順によらずに比べる。
 * 2実装（Postgres・testkit の InMemory）で同じ結果になることも見る。
 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const NOW = new Date("2026-09-27T00:00:00.000Z");
const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => NOW },
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "recall-explain-accounting" };
let seq = 0;

async function seed(kit: Kit, vectors: number[][]): Promise<MemoryId[]> {
  const ids: MemoryId[] = [];
  for (const [i, vector] of vectors.entries()) {
    seq += 1;
    const memory = await kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `explain-${seq}`,
        content: `本文 ${seq}`,
        digest: `要旨 ${seq}`,
        embeddingStatus: "ready",
        recordedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
        decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    );
    await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
    ids.push(memory.id);
  }
  return ids;
}

function detailOf(r: RecallResult, stage: string): Record<string, unknown> {
  return (r.explain.stages.find((s) => s.stage === stage)?.detail ?? {}) as Record<string, unknown>;
}

function countOf(r: RecallResult, kind: string, stage?: string): number {
  const found = r.omitted.find(
    (o) => o.kind === kind && (stage === undefined || (o as { stage?: string }).stage === stage),
  ) as { count?: number } | undefined;
  return found?.count ?? 0;
}

async function expectRecordMatches(kit: Kit, r: RecallResult): Promise<void> {
  const record = await kit.runtime.getRecall(ctx, r.recallId);
  expect(record?.omitted).toEqual(r.omitted);
  expect(record?.explain).toEqual(r.explain);
  expect(record?.indexBand).toEqual(r.index);
  expect(record?.usage).toEqual(r.usage);
  expect(record?.returnedMemories).toEqual({
    breakdownCaptured: true,
    memories: r.memories.map((m) => ({
      memoryId: m.memoryId,
      score: m.score,
      retrievedVia: m.retrievedVia,
      ...(m.companionOf !== undefined ? { companionOf: m.companionOf } : {}),
      ...(m.associationOf !== undefined ? { associationOf: m.associationOf } : {}),
    })),
  });
}

afterAll(async () => {
  await closeTestClient();
});

describe("recall の explain は、実際に起きたことと合う", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("閾値と limit で落ちた数: rescore の detail と omitted が、段3.5 で返った分を足して合う", async () => {
        const kit = await makeKit();
        await seed(kit, [
          [1, 0, 0],
          [0.9, 0.1, 0],
          [0.5, 0.5, 0],
          [0, 1, 0],
          [-1, 0, 0],
        ]);
        const q: RecallQuery = { vector: [1, 0, 0], limit: 2, scoreThreshold: 0.5 };
        const r = await kit.runtime.recall(ctx, q);

        expect(detailOf(r, "rescore")).toEqual({
          scored: 5,
          passedThreshold: 3,
          notComparable: 0,
          withinLimit: 2,
        });
        expect(countOf(r, "below_threshold")).toBe(2);
        // limit の外に出た1件は段3.5（連想枠）で返ったので、over_limit に数えない。
        expect(countOf(r, "over_limit", "rescore")).toBe(0);
        expect(r.memories.map((m) => m.retrievedVia)).toEqual(["ann", "ann", "association"]);
        expect(r.explain.stages.find((s) => s.stage === "association")?.executed).toBe(true);
        expect(detailOf(r, "association")).toEqual({ anchors: 2, hits: 1, selected: 1 });
        expect(detailOf(r, "index_band")).toEqual({ totalInScope: r.index.totalInScope });
        await expectRecordMatches(kit, r);
      });

      it("比較不能な候補が contested の同伴で返ると、score_not_comparable に数えない", async () => {
        const kit = await makeKit();
        const ids = await seed(kit, [
          [1, 0, 0],
          [0.5, 0.5, 0],
          [0, 0, 0],
        ]);
        await kit.runtime.markContested(ctx, ids[0]!, ids[2]!);
        const r = await kit.runtime.recall(ctx, { vector: [1, 0, 0], limit: 1 });

        expect(detailOf(r, "rescore")).toMatchObject({ scored: 3, notComparable: 1 });
        expect(countOf(r, "score_not_comparable")).toBe(0);
        expect(r.memories.find((m) => m.memoryId === ids[2])?.retrievedVia).toBe(
          "mandatory_companion",
        );
        expect(detailOf(r, "contradiction_resolution")).toEqual({ companionsAdded: 1 });
        await expectRecordMatches(kit, r);
      });

      it("空のクエリ: candidate_generation の executed: false は stage_skipped と対、rescore は名乗らない", async () => {
        const kit = await makeKit();
        await seed(kit, [[1, 0, 0]]);
        const r = await kit.runtime.recall(ctx, { limit: 5 } as RecallQuery);

        const executed = Object.fromEntries(
          r.explain.stages.map((s) => [s.stage, s.executed] as const),
        );
        expect(executed).toEqual({
          scope: true,
          candidate_generation: false,
          rescore: false,
          contradiction_resolution: true,
          // 連想枠は既定 on だが、この run は候補もアンカーも無いので `stage_skipped(association, "no_anchor")` と対になり executed: false。
          association: false,
          budget_truncation: true,
          index_band: true,
          record: true,
        });
        expect(r.omitted).toContainEqual({
          kind: "stage_skipped",
          stage: "candidate_generation",
          reason: "empty_query_content",
        });
        expect(r.omitted).toContainEqual({
          kind: "stage_skipped",
          stage: "association",
          reason: "no_anchor",
        });
        expect(
          r.omitted.filter(
            (o) => o.kind === "stage_skipped" && (o as { stage: string }).stage === "rescore",
          ),
        ).toEqual([]);
        expect(detailOf(r, "budget_truncation")).toMatchObject({ budgetApplied: false });
        await expectRecordMatches(kit, r);
      });
    });
  }
});
