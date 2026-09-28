import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, NewMemory, Runtime, VectorStore } from "@mnemora/core";
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
 * `consolidate` が何を統合元として選ぶかを、今の振る舞いのまま縛る（`ConsolidateTarget` の TSDoc の
 * 2026-09-27 追記）。約束を足すものではない。
 *
 * - `{ query }` は `recall()` の `memories` を `retrievedVia` によらず全部採る。連想枠（既定 on）で
 *   返った記憶も適格になり、`query.association: null` で外れる。
 * - どの形でも、いまの時点で有効期間の外にある記憶は統合元にしない（`expired`/`not_yet_valid`）。統合先は
 *   今どおり有効期間を持たない（Issue #1188。2026-09-29 に「有効期間を見ない」から変えた）。
 * 2実装（Postgres・testkit の InMemory）で同じ結果になることも見る。
 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const NOW = new Date("2026-09-27T00:00:00.000Z");
const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx: Ctx, req: { schema: unknown }) => {
      if (req.schema === ConsolidationLLMResultSchema) {
        return ConsolidationLLMResultSchema.parse({ content: "統合した本文" }) as never;
      }
      throw new Error("unexpected schema");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => NOW },
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
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
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        } as never),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "consolidate-target-selection" };
let seq = 0;

async function add(
  kit: Kit,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<MemoryId> {
  seq += 1;
  const memory = await kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `selection-${seq}`,
      content: `本文 ${seq}`,
      digest: `要旨 ${seq}`,
      embeddingStatus: "ready",
      recordedAt: new Date(NOW.getTime() - seq * 3_600_000),
      decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
      ...overrides,
    }),
  );
  await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory.id;
}

afterAll(async () => {
  await closeTestClient();
});

describe("consolidate の対象の選び方（今の振る舞い）", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("{ query } は連想枠で返った記憶も適格にし、association: null で外れる", async () => {
        const kit = await makeKit();
        const a = await add(kit, [1, 0, 0]);
        const b = await add(kit, [0.95, 0.05, 0]);
        const c = await add(kit, [0.9, 0.1, 0]);
        const recalled = await kit.runtime.recall(ctx, { vector: [1, 0, 0], limit: 2 });
        expect(recalled.memories.map((m) => [m.memoryId, m.retrievedVia])).toEqual([
          [a, "ann"],
          [b, "ann"],
          [c, "association"],
        ]);

        const byDefault = await kit.runtime.consolidate(ctx, {
          target: { query: { vector: [1, 0, 0], limit: 2 } },
          dryRun: true,
        });
        expect(byDefault.sources).toEqual([
          { memoryId: a, kind: "eligible" },
          { memoryId: b, kind: "eligible" },
          { memoryId: c, kind: "eligible" },
        ]);

        const withoutAssociation = await kit.runtime.consolidate(ctx, {
          target: { query: { vector: [1, 0, 0], limit: 2, association: null } },
          dryRun: true,
        });
        expect(withoutAssociation.sources).toEqual([
          { memoryId: a, kind: "eligible" },
          { memoryId: b, kind: "eligible" },
        ]);
      });

      it("有効期間の外にある記憶は、どの形でも統合元にしない（Issue #1188。2026-09-29 変更）", async () => {
        const PAST = new Date("2026-01-01T00:00:00.000Z");
        const FUTURE = new Date("2027-01-01T00:00:00.000Z");

        // { memoryIds }: 期限切れ E と有効な F。E を除くと1件なので統合しない。
        {
          const kit = await makeKit();
          const expired = await add(kit, [1, 0, 0], { validUntil: PAST } as Partial<NewMemory>);
          const current = await add(kit, [0.95, 0.05, 0]);
          const result = await kit.runtime.consolidate(ctx, {
            target: { memoryIds: [expired, current] },
          });
          expect(result).toMatchObject({
            outcome: "nothing_to_consolidate",
            nothingReason: "single_eligible_source",
            consolidatedMemoryId: null,
            llmCalls: 0,
          });
          expect(result.sources).toEqual([
            { memoryId: expired, kind: "expired", validUntil: PAST },
            { memoryId: current, kind: "not_attempted" },
          ]);
          expect((await kit.memoryStore.get(ctx, expired))?.status).toBe("active");
          expect((await kit.memoryStore.get(ctx, current))?.status).toBe("active");
        }

        // { memoryIds }: 未到来 U と有効な F・G。U を除いた2件を統合し、統合先は今どおり有効期間を持たない。
        {
          const kit = await makeKit();
          const future = await add(kit, [1, 0, 0], { validFrom: FUTURE } as Partial<NewMemory>);
          const f = await add(kit, [0.95, 0.05, 0]);
          const g = await add(kit, [0.9, 0.1, 0]);
          const result = await kit.runtime.consolidate(ctx, {
            target: { memoryIds: [future, f, g] },
          });
          expect(result.outcome).toBe("consolidated");
          expect(result.sources).toEqual([
            { memoryId: future, kind: "not_yet_valid", validFrom: FUTURE },
            { memoryId: f, kind: "superseded", previousStatus: "active" },
            { memoryId: g, kind: "superseded", previousStatus: "active" },
          ]);
          const consolidated = await kit.memoryStore.get(ctx, result.consolidatedMemoryId!);
          expect(consolidated?.status).toBe("active");
          expect(consolidated?.validFrom ?? null).toBeNull();
          expect(consolidated?.validUntil ?? null).toBeNull();
          expect((await kit.memoryStore.get(ctx, future))?.status).toBe("active");
        }

        // { seedMemoryId }: 期限切れの種は recall() を通らずに候補に入るが、統合元にはしない。
        {
          const kit = await makeKit();
          const seed = await add(kit, [1, 0, 0], { validUntil: PAST } as Partial<NewMemory>);
          const n1 = await add(kit, [0.99, 0.01, 0]);
          const n2 = await add(kit, [0.98, 0.02, 0]);
          const result = await kit.runtime.consolidate(ctx, {
            target: { seedMemoryId: seed, minAffinity: 0 },
            dryRun: true,
          });
          expect(result.outcome).toBe("dry_run");
          expect(result.sources).toEqual([
            { memoryId: seed, kind: "expired", validUntil: PAST },
            { memoryId: n1, kind: "eligible" },
            { memoryId: n2, kind: "eligible" },
          ]);
        }

        // { query }: includeOutsideValidity で集めても、期限切れは統合元にしない。
        {
          const kit = await makeKit();
          const expired = await add(kit, [1, 0, 0], { validUntil: PAST } as Partial<NewMemory>);
          const current = await add(kit, [0.95, 0.05, 0]);
          const viaDefault = await kit.runtime.consolidate(ctx, {
            target: { query: { vector: [1, 0, 0], limit: 5, association: null } },
            dryRun: true,
          });
          expect(viaDefault.sources.map((s) => s.memoryId)).toEqual([current]);
          const viaOutside = await kit.runtime.consolidate(ctx, {
            target: {
              query: {
                vector: [1, 0, 0],
                limit: 5,
                association: null,
                includeOutsideValidity: true,
              },
            },
            dryRun: true,
          });
          expect(viaOutside.sources).toEqual([
            { memoryId: expired, kind: "expired", validUntil: PAST },
            { memoryId: current, kind: "not_attempted" },
          ]);
        }
      });
    });
  }
});
