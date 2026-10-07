import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  MemoryId,
  MemoryStore,
  NewMemoryEvent,
  Runtime,
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
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `ResolveOrphanedContestedEligibility` の `"opposite_not_orphaned"` は、対向が `archived` のときにもなる。
 * 実装は対向が `"forgotten"` かどうかだけを見ている。今の振る舞いを Postgres と testkit の fixture の2実装で縛る。
 *
 * `Runtime` の口には `contested` な記憶を `archived` にするものが無いので、対向は store の `updateStatus` で直接 `archived` にする。
 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("この歯は LLM を呼ばない");
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
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        } as never),
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
          vectorStore: new PostgresVectorStore(db),
          eventStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        } as never),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "orphaned-contested-opposite-archived" };

function event(memoryId: MemoryId): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested" },
  };
}

afterAll(async () => {
  await closeTestClient();
});

describe("runtime.resolveOrphanedContested — 対向が archived なら opposite_not_orphaned（TSDoc の 2026-09-28 訂正）", () => {
  for (const [kitName, makeKit] of KITS) {
    it(`${kitName}: ineligible（oppositeStatus: 'archived'）を返し、生存側も対向も書き換えない`, async () => {
      const kit = await makeKit();
      const survivor = await kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "opposite-archived-survivor",
        }),
      );
      const opposite = await kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "opposite-archived-opposite",
        }),
      );
      await kit.memoryStore.markContestedPair!(
        ctx,
        { id: survivor.id, event: event(survivor.id) },
        { id: opposite.id, event: event(opposite.id) },
      );
      await kit.memoryStore.updateStatus(ctx, opposite.id, "archived");
      const survivorEventsBefore = await kit.eventStore.list(ctx, { memoryId: survivor.id });

      const result = await kit.runtime.resolveOrphanedContested!(ctx, survivor.id);

      expect(result).toEqual({
        supported: true,
        outcome: {
          kind: "ineligible",
          eligibility: {
            kind: "opposite_not_orphaned",
            contestedWithId: opposite.id,
            oppositeStatus: "archived",
          },
        },
      });
      const survivorAfter = await kit.memoryStore.get(ctx, survivor.id);
      const oppositeAfter = await kit.memoryStore.get(ctx, opposite.id);
      expect({
        survivorStatus: survivorAfter?.status,
        survivorContestedWithId: survivorAfter?.contestedWithId,
        oppositeStatus: oppositeAfter?.status,
        survivorEvents: (await kit.eventStore.list(ctx, { memoryId: survivor.id })).length,
      }).toEqual({
        survivorStatus: "contested",
        survivorContestedWithId: opposite.id,
        oppositeStatus: "archived",
        survivorEvents: survivorEventsBefore.length,
      });
    });
  }
});
