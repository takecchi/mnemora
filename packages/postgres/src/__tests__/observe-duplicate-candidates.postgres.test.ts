import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LLMProvider,
  MemoryStore,
  OutboxStore,
  Runtime,
} from "@mnemora/core";
import { ExtractionResultSchema, createRuntime } from "@mnemora/core";
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
 * `ObserveResult.memoryIds` の doc に書いた、同じ本文の抽出候補が複数あるときの振る舞い
 * （`packages/core/src/runtime.ts`）を、Postgres と testkit の InMemory の両方で縛る。
 *
 * - `memoryIds` は候補ごとに1要素・候補の順で、同じ本文の候補には同じ id が入る。
 * - 2件目以降の候補の `provenanceKind`・`confidence`・`subjectId`・`tags` は書かれない。
 * - Memory・`created` イベント・`embed` ジョブは、本文ごとに1つずつだけ。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if ((req.schema as unknown) !== ExtractionResultSchema) throw new Error("unexpected schema");
    return req.schema.parse({
      memories: [
        { content: "同じ事実", provenanceKind: "stated", tags: ["a"] },
        {
          content: "同じ事実",
          provenanceKind: "inferred",
          confidence: 0.9,
          tags: ["b"],
          subjectId: "other",
        },
        { content: "別の事実", provenanceKind: "stated" },
      ],
    });
  },
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  outboxStore: OutboxStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      const runtime = createRuntime({
        ...shared,
        memoryStore,
        outboxStore,
        eventStore,
        vectorStore: new InMemoryVectorStore(memoryStore),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      });
      return { runtime, memoryStore, eventStore, outboxStore };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const outboxStore = new PostgresOutboxStore(db);
      const eventStore = new PostgresEventStore(db);
      const runtime = createRuntime({
        ...shared,
        memoryStore,
        outboxStore,
        eventStore,
        vectorStore: new PostgresVectorStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      });
      return { runtime, memoryStore, eventStore, outboxStore };
    },
  ],
];

const ctx: Ctx = { tenantId: "observe-duplicate-candidates" };

afterAll(async () => {
  await closeTestClient();
});

describe("observe: 同じ本文の抽出候補が複数あるとき（ObserveResult.memoryIds の doc）", () => {
  it.each(KITS)("%s", async (_name, makeKit) => {
    const { runtime, memoryStore, eventStore, outboxStore } = await makeKit();

    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });

    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(3);
    const [first, second, third] = result.memoryIds;
    expect(second).toBe(first);
    expect(third).not.toBe(first);

    const memory = (await memoryStore.get(ctx, first!))!;
    expect(memory.provenance.kind).toBe("stated");
    expect(memory.tags).toEqual(["a"]);
    expect(memory.subjectId).toBeNull();

    expect(await eventStore.list(ctx, { kind: "created" })).toHaveLength(2);
    const embedJobs = await outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 100,
      now: new Date(Date.now() + 60 * 60_000),
      claimedBy: "observe-duplicate-candidates",
      leaseMs: 60_000,
    });
    expect(embedJobs.map((job) => job.payload["memoryId"]).sort()).toEqual([first, third].sort());
  });
});
