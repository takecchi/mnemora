import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime, TenantSettingsStore } from "@mnemora/core";
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
 * `decay_clock` を `'wall'` から `'activity'` へ切り替えたときの今の振る舞いを縛る。Postgres と testkit の fixture で同じ。
 *
 * - `'wall'` の間に作られた記憶は、活動時計の3つ組（`decayBaseSeq`・`decayFloorSeq`・`halfLifeRecalls`）が
 *   `null` のまま作られる（`decay_base_seq` も 0 ではなく `null`）。
 * - 切り替えた後、活動時計がどれだけ進んでも、その記憶は `sweepArchive` に選ばれない（床が無い）。
 *   切り替えた後に作られた記憶は選ばれる。
 */

/** 抽出の LLM が返す本文。 */
let nextContent = "";
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({ memories: [{ content: nextContent, provenanceKind: "stated" }] }),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  tenantSettingsStore: TenantSettingsStore;
}

const shared = {
  llmProvider: llm,
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
      const tenantSettingsStore = new InMemoryTenantSettingsStore(memoryStore.activitySeq);
      return {
        memoryStore,
        tenantSettingsStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          tenantSettingsStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
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
      const tenantSettingsStore = new PostgresTenantSettingsStore(db);
      return {
        memoryStore,
        tenantSettingsStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          tenantSettingsStore,
          eventStore: new PostgresEventStore(db),
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "wall-to-activity-switch" };

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: wall から activity へ切り替える（今の振る舞い、Issue #1014）`, () => {
    it("wall の間の記憶は3つ組が null で、切り替えた後に活動時計が進んでも sweepArchive に選ばれない", async () => {
      const kit = await makeKit();
      nextContent = "切り替える前の事実";
      const before = (await kit.runtime.observe(ctx, { kind: "utterance", text: "前" }))
        .memoryIds[0]!;
      const created = (await kit.memoryStore.get(ctx, before))!;
      expect([created.decayBaseSeq, created.decayFloorSeq, created.halfLifeRecalls]).toEqual([
        null,
        null,
        null,
      ]);

      await kit.tenantSettingsStore.setDecayClock!(ctx, "activity");
      await kit.tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1);
      nextContent = "切り替えた後の事実";
      const after = (await kit.runtime.observe(ctx, { kind: "utterance", text: "後" }))
        .memoryIds[0]!;
      const afterMemory = (await kit.memoryStore.get(ctx, after))!;
      expect(afterMemory.decayFloorSeq).not.toBeNull();

      for (let i = 0; i < 20; i += 1) {
        await kit.runtime.recall(ctx, { text: "無関係の問い", limit: 1, association: null });
      }
      const swept = await kit.runtime.sweepArchive(ctx, { now: new Date(), limit: 10 });
      const archivedIds = swept.archived.map((x) => x.memoryId);
      expect(archivedIds).toContain(after);
      expect(archivedIds).not.toContain(before);
      expect((await kit.memoryStore.get(ctx, before))!.status).toBe("active");
    });
  });
}
