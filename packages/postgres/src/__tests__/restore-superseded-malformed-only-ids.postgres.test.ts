import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, Runtime } from "@mnemora/core";
import { ConsolidationLLMResultSchema, createRuntime } from "@mnemora/core";
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
 * `restoreSuperseded` の `onlyMemoryIds` に、uuid の形をしていない id が混ざっても例外にしない——
 * その id は群に居ないのと同じに扱う。`supersededById` の形式不正は例外にしない（`Runtime.restoreSuperseded`
 * の doc）、`getMany` は形式不正な id を無いものとして扱う（`isUuidLike` の doc）、と同じ規律である。
 *
 * 【実測 2026-09-27、修正前】`PostgresMemoryStore.restoreSupersededBy`・`previewRestoreSupersededBy` は
 * `onlyMemoryIds` をそのまま `::uuid[]` に渡し、`invalid input syntax for type uuid` を漏らしていた。
 * testkit の InMemory は、形式不正な id を群に居ないものとして扱って返していた。
 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () =>
      ConsolidationLLMResultSchema.parse({ content: "統合した本文" }) as never,
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
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          vectorStore: new InMemoryVectorStore(memoryStore),
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
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore: new PostgresEventStore(db),
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        } as never),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "restore-superseded-malformed-only-ids" };
const MALFORMED = "not-a-uuid" as MemoryId;
let seq = 0;

async function consolidatedGroup(kit: Kit): Promise<{ winner: MemoryId; losers: MemoryId[] }> {
  const losers: MemoryId[] = [];
  for (let i = 0; i < 2; i++) {
    seq += 1;
    const memory = await kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `malformed-${seq}`,
        content: `本文 ${seq}`,
      }),
    );
    losers.push(memory.id);
  }
  const result = await kit.runtime.consolidate(ctx, { target: { memoryIds: losers } });
  return { winner: result.consolidatedMemoryId!, losers };
}

afterAll(async () => {
  await closeTestClient();
});

describe("restoreSuperseded の onlyMemoryIds に形式不正な id が混ざっても例外にしない", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("dryRun: 形式不正な id は群に居ないのと同じ", async () => {
        const kit = await makeKit();
        const { winner, losers } = await consolidatedGroup(kit);
        const result = await kit.runtime.restoreSuperseded(
          ctx,
          { supersededById: winner, onlyMemoryIds: [losers[0]!, MALFORMED] },
          { dryRun: true },
        );
        expect(result.outcomes.map((o) => [o.memoryId, o.kind])).toEqual([
          [losers[0], "would_restore"],
        ]);
      });

      it("実行: 形式不正な id は群に居ないのと同じで、ほかの id は戻る", async () => {
        const kit = await makeKit();
        const { winner, losers } = await consolidatedGroup(kit);
        const result = await kit.runtime.restoreSuperseded(ctx, {
          supersededById: winner,
          onlyMemoryIds: [losers[0]!, MALFORMED],
        });
        expect(result.outcomes.map((o) => [o.memoryId, o.kind])).toEqual([[losers[0], "restored"]]);
        expect((await kit.memoryStore.get(ctx, losers[0]!))?.status).toBe("active");
        expect((await kit.memoryStore.get(ctx, losers[1]!))?.status).toBe("superseded");
      });

      it("形式不正な id だけなら、対象0件", async () => {
        const kit = await makeKit();
        const { winner } = await consolidatedGroup(kit);
        const result = await kit.runtime.restoreSuperseded(ctx, {
          supersededById: winner,
          onlyMemoryIds: [MALFORMED],
        });
        expect(result.outcomes).toEqual([]);
      });
    });
  }
});
