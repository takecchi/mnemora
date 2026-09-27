import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock, Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * 注入した時計（`RuntimeDeps.clock`）が届く時刻と届かない時刻の今の振る舞いを縛る（Issue #1237。
 * `Clock` の doc の 2026-09-27 追記）。振る舞いは変えていない。Postgres と testkit の fixture で同じ。
 *
 * 1. Memory の `recordedAt` は注入した時計、監査ログの `at` と recall の記録の `createdAt` は壁時計。
 * 2. outbox の `available_at` は壁時計、`tick` の claim の `now` は注入した時計。そのため、壁時計より
 *    過去の時計では `tick` がジョブを1本も取らない（何も名乗らない）。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({ memories: [{ content: "事実です", provenanceKind: "stated" }] }),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

function sharedWith(clock: Clock) {
  return {
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    clock,
  };
}

const KITS: Array<[string, (clock: Clock) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (clock) => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...sharedWith(clock),
          memoryStore,
          eventStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (clock) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...sharedWith(clock),
          memoryStore,
          eventStore,
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "injected-clock-reach" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");

/** テストが走っている間の壁時計の時刻か（前後1秒の余裕）。 */
function isWallNow(date: Date, startedAt: number): boolean {
  return date.getTime() >= startedAt - 1000 && date.getTime() <= Date.now() + 1000;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 注入した時計が届く時刻と届かない時刻（今の振る舞い）`, () => {
    it("Memory の recordedAt は注入した時計、監査ログの at と recall の記録の createdAt は壁時計", async () => {
      const startedAt = Date.now();
      const kit = await makeKit({ now: () => new Date(FUTURE) });
      const observed = await kit.runtime.observe(ctx, { kind: "utterance", text: "事実を1つ" });
      const memoryId = observed.memoryIds[0]!;
      expect((await kit.memoryStore.get(ctx, memoryId))?.recordedAt).toEqual(FUTURE);

      const [created] = await kit.eventStore.list(ctx, { memoryId, kind: "created" });
      expect(isWallNow(created!.at, startedAt)).toBe(true);

      const recalled = await kit.runtime.recall(ctx, { text: "事実", limit: 3, association: null });
      const record = await kit.runtime.getRecall(ctx, recalled.recallId);
      expect(isWallNow(record!.createdAt, startedAt)).toBe(true);
    });

    it("壁時計より過去の時計では、tick は積んだジョブを1本も取らない（未来の時計なら取る）", async () => {
      for (const [clockAt, expected] of [
        [PAST, 0],
        [FUTURE, 1],
      ] as const) {
        const kit = await makeKit({ now: () => new Date(clockAt) });
        await kit.runtime.observe(ctx, {
          kind: "utterance",
          text: "事実を1つ",
          extract: "deferred",
        });
        expect(await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 })).toEqual({
          processed: expected,
          failed: 0,
          unsupported: [],
          leaseConflicts: [],
        });
      }
    });
  });
}
