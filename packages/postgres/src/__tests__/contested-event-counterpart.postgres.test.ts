import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryId, MemoryStore, Runtime } from "@mnemora/core";
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

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

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
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          vectorStore: new InMemoryVectorStore(memoryStore),
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
    },
  ],
];

const ctx: Ctx = { tenantId: "contested-event-counterpart" };
let seq = 0;

async function pair(memoryStore: MemoryStore): Promise<[MemoryId, MemoryId]> {
  const ids: MemoryId[] = [];
  for (let i = 0; i < 2; i++) {
    seq += 1;
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `counterpart-${seq}`,
        content: `本文 ${seq}`,
      }),
    );
    ids.push(memory.id);
  }
  return [ids[0]!, ids[1]!];
}

async function metaOf(
  eventStore: EventStore,
  memoryId: MemoryId,
  reason: string,
): Promise<Record<string, unknown>[]> {
  const events = await eventStore.list(ctx, { memoryId });
  return events.map((e) => e.meta).filter((meta) => meta.reason === reason);
}

afterAll(async () => {
  await closeTestClient();
});

describe("対にまつわるイベントの meta に、対向の id（contestedWithId）が入る", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("markContested: 両側のイベントに、互いの id", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await pair(memoryStore);
        await runtime.markContested(ctx, a, b);

        expect(await metaOf(eventStore, a, "contested")).toEqual([
          { reason: "contested", contestedWithId: b },
        ]);
        expect(await metaOf(eventStore, b, "contested")).toEqual([
          { reason: "contested", contestedWithId: a },
        ]);
      });

      it("resolveContested(both_active): 両側のイベントに、互いの id", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await pair(memoryStore);
        await runtime.markContested(ctx, a, b);
        await runtime.resolveContested(ctx, a, b, { kind: "both_active" });

        expect(await metaOf(eventStore, a, "contested_resolved")).toEqual([
          { reason: "contested_resolved", resolution: "both_active", contestedWithId: b },
        ]);
        expect(await metaOf(eventStore, b, "contested_resolved")).toEqual([
          { reason: "contested_resolved", resolution: "both_active", contestedWithId: a },
        ]);
      });

      it("resolveContested(supersede): 勝者にも敗者にも相手の id（敗者は supersededById も）", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await pair(memoryStore);
        await runtime.markContested(ctx, a, b);
        await runtime.resolveContested(ctx, a, b, { kind: "supersede", winnerId: b });

        expect(await metaOf(eventStore, b, "contested_resolved")).toEqual([
          { reason: "contested_resolved", resolution: "supersede", contestedWithId: a },
        ]);
        expect(await metaOf(eventStore, a, "contested_resolved")).toEqual([
          {
            reason: "contested_resolved",
            resolution: "supersede",
            contestedWithId: b,
            supersededById: b,
          },
        ]);
      });

      it("opts.reason を渡しても、note と一緒に対向の id が入る（markContested・resolveContested・resolveOrphanedContested）", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await pair(memoryStore);
        await runtime.markContested(ctx, a, b, { reason: "mark-note" });
        expect(await metaOf(eventStore, a, "contested")).toEqual([
          { reason: "contested", note: "mark-note", contestedWithId: b },
        ]);
        expect(await metaOf(eventStore, b, "contested")).toEqual([
          { reason: "contested", note: "mark-note", contestedWithId: a },
        ]);

        await runtime.resolveContested(ctx, a, b, { kind: "both_active" }, { reason: "both-note" });
        expect(await metaOf(eventStore, a, "contested_resolved")).toEqual([
          {
            reason: "contested_resolved",
            resolution: "both_active",
            note: "both-note",
            contestedWithId: b,
          },
        ]);
        expect(await metaOf(eventStore, b, "contested_resolved")).toEqual([
          {
            reason: "contested_resolved",
            resolution: "both_active",
            note: "both-note",
            contestedWithId: a,
          },
        ]);

        const [c, d] = await pair(memoryStore);
        await runtime.markContested(ctx, c, d);
        await runtime.resolveContested(
          ctx,
          c,
          d,
          { kind: "supersede", winnerId: d },
          { reason: "sup-note" },
        );
        expect(await metaOf(eventStore, d, "contested_resolved")).toEqual([
          {
            reason: "contested_resolved",
            resolution: "supersede",
            note: "sup-note",
            contestedWithId: c,
          },
        ]);
        expect(await metaOf(eventStore, c, "contested_resolved")).toEqual([
          {
            reason: "contested_resolved",
            resolution: "supersede",
            note: "sup-note",
            contestedWithId: d,
            supersededById: d,
          },
        ]);

        const [e, f] = await pair(memoryStore);
        await runtime.markContested(ctx, e, f);
        await runtime.forget(ctx, { memoryIds: [e] });
        await runtime.resolveOrphanedContested!(ctx, f, { reason: "orphan-note" });
        expect(await metaOf(eventStore, f, "contested_resolved")).toEqual([
          {
            reason: "contested_resolved",
            resolution: "orphan_reclaimed",
            note: "orphan-note",
            contestedWithId: e,
          },
        ]);
      });

      it("resolveOrphanedContested: 生き残った側のイベントに、forget された対向の id", async () => {
        const { runtime, memoryStore, eventStore } = await makeKit();
        const [a, b] = await pair(memoryStore);
        await runtime.markContested(ctx, a, b);
        await runtime.forget(ctx, { memoryIds: [a] });
        await runtime.resolveOrphanedContested!(ctx, b);

        expect(await metaOf(eventStore, b, "contested_resolved")).toEqual([
          { reason: "contested_resolved", resolution: "orphan_reclaimed", contestedWithId: a },
        ]);
      });
    });
  }
});
