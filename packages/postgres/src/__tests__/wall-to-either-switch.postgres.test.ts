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
 * `decay_clock` を `'wall'` から `'either'` へ切り替えても、`'wall'` の間に作られた記憶は活動時計の床を持たず、
 * 壁時計の床が過ぎていても `sweepArchive`（`'either'` は両方の軸が沈んだものだけを掃く）に選ばれない。
 * 切り替えた後に作られた記憶は、両方の軸が沈めば選ばれる。
 */

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

const ctx: Ctx = { tenantId: "wall-to-either-switch" };
const FAR_FUTURE = new Date("2100-01-01T00:00:00.000Z");

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: wall から either へ切り替える`, () => {
    it("wall の間の記憶は、壁時計の床が過ぎていても sweepArchive に選ばれず、切り替えた後の記憶は両方の軸が沈めば選ばれる", async () => {
      const kit = await makeKit();
      nextContent = "切り替える前の事実";
      const before = (await kit.runtime.observe(ctx, { kind: "utterance", text: "前" }))
        .memoryIds[0]!;
      expect((await kit.memoryStore.get(ctx, before))!.decayFloorSeq).toBeNull();

      await kit.tenantSettingsStore.setDecayClock!(ctx, "either");
      await kit.tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1);
      nextContent = "切り替えた後の事実";
      const after = (await kit.runtime.observe(ctx, { kind: "utterance", text: "後" }))
        .memoryIds[0]!;

      for (let i = 0; i < 20; i += 1) {
        await kit.runtime.recall(ctx, { text: "無関係の問い", limit: 1, association: null });
      }
      const swept = await kit.runtime.sweepArchive(ctx, { now: FAR_FUTURE, limit: 10 });
      const archivedIds = swept.archived.map((x) => x.memoryId);
      expect(archivedIds).toContain(after);
      expect(archivedIds).not.toContain(before);
      expect((await kit.memoryStore.get(ctx, before))!.status).toBe("active");
    });
  });
}
