import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, Runtime, TenantSettingsStore } from "@mnemora/core";
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
 * `findCorrectionCandidates` が書くものを縛る（Issue #1244。`Runtime.findCorrectionCandidates` の doc の
 * 2026-09-27 訂正）。振る舞いは変えていない。
 *
 * Memory の `status` と `memory_events` には書かない。ただし中で1回呼ぶ `recall()` が、recall の記録を1件書き
 * （戻り値の `recallId`）、`decay_clock` が `'wall'` 以外のテナントでは `activity_seq` を1進める。
 * Postgres と testkit の fixture で同じ。
 */

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
  clock: { now: () => new Date("2026-09-27T00:00:00.000Z") },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  settings: TenantSettingsStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      const settings = new InMemoryTenantSettingsStore(memoryStore.activitySeq);
      return {
        memoryStore,
        eventStore,
        settings,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
          tenantSettingsStore: settings,
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
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
      const settings = new PostgresTenantSettingsStore(db);
      return {
        memoryStore,
        eventStore,
        settings,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
          tenantSettingsStore: settings,
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "correction-candidates-recall-record" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: findCorrectionCandidates が書くもの（今の振る舞い）`, () => {
    it.each(["wall", "activity"] as const)(
      "decay_clock=%s: status と memory_events は変えず、recall の記録を1件書く",
      async (decayClock) => {
        const kit = await makeKit();
        await kit.settings.setDecayClock!(ctx, decayClock);
        await kit.memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: "target",
            content: "東京に住んでいる",
            embeddingStatus: "ready",
          }),
        );
        const eventsBefore = (await kit.eventStore.list(ctx, {})).length;
        const seqBefore = await kit.settings.getActivitySeq!(ctx);

        const result = await kit.runtime.findCorrectionCandidates(ctx, {
          text: "大阪に引っ越した",
        });

        expect((await kit.eventStore.list(ctx, {})).length).toBe(eventsBefore);
        const record = await kit.runtime.getRecall(ctx, result.recallId);
        expect(record).not.toBeNull();
        expect(record!.query).toMatchObject({ text: "大阪に引っ越した" });
        expect(await kit.settings.getActivitySeq!(ctx)).toBe(
          decayClock === "wall" ? seqBefore : seqBefore + 1,
        );
      },
    );
  });
}
