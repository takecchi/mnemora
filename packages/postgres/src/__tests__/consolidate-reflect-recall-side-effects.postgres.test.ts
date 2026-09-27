import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime, TenantSettingsStore } from "@mnemora/core";
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
 * `consolidate`・`reflect` の `{ query }`・`{ seedMemoryId }` は、doc が「書き込みゼロ」と書く枝でも、手順1の
 * `recall()` が recall の記録を1件書き、活動時計を進める——今の振る舞いを縛る（Issue #1248。両メソッドの doc の
 * 2026-09-27 追記）。振る舞いは変えていない。`{ memoryIds }` はどちらも起こさない。Postgres と testkit の fixture で同じ。
 */

let llmFails = false;
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (llmFails) throw new Error("llm down");
    const reflected = req.schema.safeParse({
      outcome: "reflected",
      content: "内省",
      digest: "内省",
    });
    return reflected.success
      ? reflected.data
      : req.schema.parse({ content: "統合", digest: "統合" });
  },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  settings: TenantSettingsStore;
  counts: () => Promise<{ recalls: number; events: number }>;
  upsert: (id: string) => Promise<void>;
}

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => new Date("2026-09-27T00:00:00.000Z") },
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      const settings = new InMemoryTenantSettingsStore(memoryStore.activitySeq);
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        settings,
        counts: async () => ({
          recalls: memoryStore.recalls.size,
          events: (await eventStore.list(ctx, {})).length,
        }),
        upsert: (id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore,
          tenantSettingsStore: settings,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const vectorStore = new PostgresVectorStore(db);
      const settings = new PostgresTenantSettingsStore(db);
      const count = async (table: string) =>
        ((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n;
      return {
        memoryStore,
        settings,
        counts: async () => ({
          recalls: await count("recalls"),
          events: await count("memory_events"),
        }),
        upsert: (id) => vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, [1, 0, 0]),
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new PostgresEventStore(db),
          tenantSettingsStore: settings,
          outboxStore: new PostgresOutboxStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "consolidate-reflect-recall-side-effects" };
let seq = 0;

async function createIndexed(kit: Kit) {
  seq += 1;
  const memory = await kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `side-${seq}`,
      content: `記憶 ${seq}`,
      digest: `記憶 ${seq}`,
      embeddingStatus: "ready",
      recordedAt: new Date("2026-09-26T00:00:00.000Z"),
      decayFloorAt: new Date("2031-01-01T00:00:00.000Z"),
    }),
  );
  await kit.upsert(memory.id);
  return memory;
}

afterAll(async () => {
  await closeTestClient();
});

type Case = [string, (kit: Kit, seedId: string) => Promise<{ outcome: string }>, string, number];
const CASES: Case[] = [
  [
    "consolidate { seedMemoryId } の dryRun",
    (kit, seedId) =>
      kit.runtime.consolidate(ctx, { target: { seedMemoryId: seedId }, dryRun: true }),
    "nothing_to_consolidate",
    1,
  ],
  [
    "consolidate { query }（eligible 1件）",
    (kit) => kit.runtime.consolidate(ctx, { target: { query: { text: "記憶" } } }),
    "nothing_to_consolidate",
    1,
  ],
  [
    "reflect { seedMemoryId } の dryRun",
    (kit, seedId) => kit.runtime.reflect(ctx, { target: { seedMemoryId: seedId }, dryRun: true }),
    "dry_run",
    1,
  ],
  [
    "consolidate { memoryIds } の dryRun",
    (kit, seedId) =>
      kit.runtime.consolidate(ctx, { target: { memoryIds: [seedId] }, dryRun: true }),
    "nothing_to_consolidate",
    0,
  ],
];

for (const [name, makeKit] of KITS) {
  describe(`${name}: 書き込みゼロの枝でも、手順1の recall() が書くもの（今の振る舞い、decay_clock=activity）`, () => {
    it.each(CASES)("%s", async (_label, call, outcome, recalls) => {
      const kit = await makeKit();
      await kit.settings.setDecayClock!(ctx, "activity");
      const seed = await createIndexed(kit);
      const before = await kit.counts();
      const seqBefore = await kit.settings.getActivitySeq!(ctx);

      expect((await call(kit, seed.id)).outcome).toBe(outcome);

      const after = await kit.counts();
      expect(after.events).toBe(before.events);
      expect(after.recalls - before.recalls).toBe(recalls);
      expect((await kit.settings.getActivitySeq!(ctx)) - seqBefore).toBe(recalls);
    });

    it("consolidate・reflect の { query }: LLM が失敗しても recall の記録を書き、活動時計を進める", async () => {
      const kit = await makeKit();
      await kit.settings.setDecayClock!(ctx, "activity");
      await createIndexed(kit);
      await createIndexed(kit);
      llmFails = true;
      try {
        for (const call of [
          () => kit.runtime.consolidate(ctx, { target: { query: { text: "記憶" } } }),
          () => kit.runtime.reflect(ctx, { target: { query: { text: "記憶" } } }),
        ]) {
          const before = await kit.counts();
          const seqBefore = await kit.settings.getActivitySeq!(ctx);
          expect((await call()).outcome).toBe("llm_failed");
          const after = await kit.counts();
          expect(after.events).toBe(before.events);
          expect(after.recalls - before.recalls).toBe(1);
          expect((await kit.settings.getActivitySeq!(ctx)) - seqBefore).toBe(1);
        }
      } finally {
        llmFails = false;
      }
    });
  });
}
