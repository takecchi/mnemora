import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LLMProvider,
  MemoryEvent,
  MemoryId,
  MemoryStore,
  Runtime,
  StructuredRequest,
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

/** 統合先の `created` を積む場所は3つある。core の Fake を通る歯は2段の経路しか通らないので、ここでは実 Postgres と InMemory を、口あり・口なしの両方で通す。 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const llmProvider: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
    req.schema.parse({ content: "統合後の本文" }) as U,
};

const shared = {
  llmProvider,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => `sha256(${content})`,
};

function withoutAtomicMouth<T extends MemoryStore>(store: T): T {
  (store as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories = undefined;
  return store;
}

async function inMemoryKit(atomicMouth: boolean): Promise<Kit> {
  const raw = new InMemoryMemoryStore();
  const memoryStore = atomicMouth ? raw : withoutAtomicMouth(raw);
  const eventStore = new InMemoryEventStore(raw, raw.events);
  return {
    memoryStore,
    eventStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      eventStore,
      outboxStore: new InMemoryOutboxStore(raw.outboxJobs),
      vectorStore: new InMemoryVectorStore(raw),
      tenantSettingsStore: new InMemoryTenantSettingsStore(raw.activitySeq),
    }),
  };
}

async function postgresKit(atomicMouth: boolean): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const raw = new PostgresMemoryStore(db);
  const memoryStore = atomicMouth ? raw : withoutAtomicMouth(raw);
  const eventStore = new PostgresEventStore(db);
  return {
    memoryStore,
    eventStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      eventStore,
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    }),
  };
}

const KITS: Array<
  [string, () => Promise<Kit>, expectedAtomicity: "store_supported" | "store_unsupported"]
> = [
  ["Postgres（supersedeWithNewMemories あり）", () => postgresKit(true), "store_supported"],
  ["Postgres（supersedeWithNewMemories なし）", () => postgresKit(false), "store_unsupported"],
  [
    "testkit の InMemory（supersedeWithNewMemories あり）",
    () => inMemoryKit(true),
    "store_supported",
  ],
  [
    "testkit の InMemory（supersedeWithNewMemories なし）",
    () => inMemoryKit(false),
    "store_unsupported",
  ],
];

const ctx: Ctx = { tenantId: "consolidate-created-event-actor-note" };
let seq = 0;

async function seedTwo(memoryStore: MemoryStore): Promise<[MemoryId, MemoryId]> {
  const ids: MemoryId[] = [];
  for (let i = 0; i < 2; i++) {
    seq += 1;
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `consolidate-actor-note-${seq}`,
        content: `本文 ${seq}`,
      }),
    );
    ids.push(memory.id);
  }
  return [ids[0]!, ids[1]!];
}

async function eventsOf(
  eventStore: EventStore,
  memoryId: MemoryId,
  kind: "created" | "superseded",
): Promise<MemoryEvent[]> {
  const events = await eventStore.list(ctx, { memoryId });
  return events.filter((e) => e.kind === kind);
}

afterAll(async () => {
  await closeTestClient();
});

describe("consolidate: 統合先の created にも actor と reason（meta.note）が入る", () => {
  for (const [kitName, makeKit, expectedAtomicity] of KITS) {
    describe(kitName, () => {
      it("actor と reason を渡す: 統合先の created と統合元の superseded に同じ actor と note", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await seedTwo(memoryStore);
        const actor = { type: "human", id: "operator-1" } as const;

        const result = await runtime.consolidate(ctx, {
          target: { memoryIds: [a, b] },
          actor,
          reason: "operator-merge",
        });
        expect(result.outcome).toBe("consolidated");
        expect(result.atomicity).toBe(expectedAtomicity);
        const newId = result.consolidatedMemoryId!;

        const created = await eventsOf(eventStore, newId, "created");
        expect(created).toHaveLength(1);
        expect(created[0]!.actor).toEqual(actor);
        expect(created[0]!.meta).toEqual({
          reason: "consolidated",
          sources: [a, b],
          note: "operator-merge",
        });

        for (const sourceId of [a, b]) {
          const superseded = await eventsOf(eventStore, sourceId, "superseded");
          expect(superseded).toHaveLength(1);
          expect(superseded[0]!.actor).toEqual(actor);
          expect(superseded[0]!.meta).toEqual({
            reason: "consolidated",
            supersededById: newId,
            note: "operator-merge",
          });
        }
      });

      it("actor と reason を省略する: actor は system で、note は付かない", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await seedTwo(memoryStore);

        const result = await runtime.consolidate(ctx, { target: { memoryIds: [a, b] } });
        expect(result.outcome).toBe("consolidated");
        const newId = result.consolidatedMemoryId!;

        const created = await eventsOf(eventStore, newId, "created");
        expect(created).toHaveLength(1);
        expect(created[0]!.actor).toEqual({ type: "system" });
        expect(created[0]!.meta).toEqual({ reason: "consolidated", sources: [a, b] });

        for (const sourceId of [a, b]) {
          const superseded = await eventsOf(eventStore, sourceId, "superseded");
          expect(superseded).toHaveLength(1);
          expect(superseded[0]!.actor).toEqual({ type: "system" });
          expect(superseded[0]!.meta).toEqual({ reason: "consolidated", supersededById: newId });
        }
      });
    });
  }
});
