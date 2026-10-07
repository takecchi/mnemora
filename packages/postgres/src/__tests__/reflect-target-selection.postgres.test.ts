import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, NewMemory, Runtime, VectorStore } from "@mnemora/core";
import { createRuntime, ReflectionLLMResultSchema } from "@mnemora/core";
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
 * `reflect` が何を材料として選ぶかを、`ConsolidateTarget` と対になる形で縛る（`consolidate-target-selection.postgres.test.ts` と同じ形）。
 *
 * どの形（`{ memoryIds }`・`{ seedMemoryId }`・`{ query }`）でも、いまの時点で有効期間の外にある記憶は材料にしない
 * （`basis` に `"expired"`/`"not_yet_valid"`）。2実装（Postgres・testkit の InMemory）で同じ結果になることも見る。
 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const NOW = new Date("2026-09-29T00:00:00.000Z");
const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx: Ctx, req: { schema: unknown }) => {
      if (req.schema === ReflectionLLMResultSchema) {
        return ReflectionLLMResultSchema.parse({
          outcome: "reflected",
          content: "内省した本文",
        }) as never;
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

const ctx: Ctx = { tenantId: "reflect-target-selection" };
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
      contentHash: `reflect-selection-${seq}`,
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

describe("reflect の対象の選び方（今の振る舞い）", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("有効期間の外にある記憶は、どの形でも材料にしない（Issue #1188）", async () => {
        const PAST = new Date("2026-01-01T00:00:00.000Z");
        const FUTURE = new Date("2027-01-01T00:00:00.000Z");

        // { memoryIds }: 期限切れ E と有効な C。E は expired で名指しし、C だけが材料になる。
        {
          const kit = await makeKit();
          const expired = await add(kit, [1, 0, 0], { validUntil: PAST } as Partial<NewMemory>);
          const current = await add(kit, [0.95, 0.05, 0]);
          const result = await kit.runtime.reflect(ctx, {
            target: { memoryIds: [expired, current] },
          });
          expect(result.outcome).toBe("reflected");
          expect(result.basis).toEqual([
            { memoryId: expired, kind: "expired", validUntil: PAST },
            { memoryId: current, kind: "used" },
          ]);
          expect((await kit.memoryStore.get(ctx, expired))?.status).toBe("active");
          expect((await kit.memoryStore.get(ctx, current))?.status).toBe("active");
        }

        // { memoryIds }: 未到来 U と有効な F・G。U を除いた2件が材料になる。F・G はどちらも有効期間を持たない
        // （`add` はデフォルトで validFrom/validUntil を付けない）ので、積も両方 null。非 null な積は `consolidate-reflect-carryover.postgres.test.ts` の専用の it が検査する。
        {
          const kit = await makeKit();
          const future = await add(kit, [1, 0, 0], { validFrom: FUTURE } as Partial<NewMemory>);
          const f = await add(kit, [0.95, 0.05, 0]);
          const g = await add(kit, [0.9, 0.1, 0]);
          const result = await kit.runtime.reflect(ctx, {
            target: { memoryIds: [future, f, g] },
          });
          expect(result.outcome).toBe("reflected");
          expect(result.basis).toEqual([
            { memoryId: future, kind: "not_yet_valid", validFrom: FUTURE },
            { memoryId: f, kind: "used" },
            { memoryId: g, kind: "used" },
          ]);
          const reflected = await kit.memoryStore.get(ctx, result.reflectedMemoryId!);
          expect(reflected?.validFrom ?? null).toBeNull();
          expect(reflected?.validUntil ?? null).toBeNull();
          expect((await kit.memoryStore.get(ctx, future))?.status).toBe("active");
        }

        // { seedMemoryId }: 期限切れの種は recall() を通らずに候補に入るが、材料にはしない。
        {
          const kit = await makeKit();
          const seed = await add(kit, [1, 0, 0], { validUntil: PAST } as Partial<NewMemory>);
          const n1 = await add(kit, [0.99, 0.01, 0]);
          const n2 = await add(kit, [0.98, 0.02, 0]);
          const result = await kit.runtime.reflect(ctx, {
            target: { seedMemoryId: seed, minAffinity: 0 },
            dryRun: true,
          });
          expect(result.outcome).toBe("dry_run");
          expect(result.basis).toEqual([
            { memoryId: seed, kind: "expired", validUntil: PAST },
            { memoryId: n1, kind: "eligible" },
            { memoryId: n2, kind: "eligible" },
          ]);
        }

        // { query }: includeOutsideValidity で集めても、期限切れは材料にしない。
        {
          const kit = await makeKit();
          const expired = await add(kit, [1, 0, 0], { validUntil: PAST } as Partial<NewMemory>);
          const current = await add(kit, [0.95, 0.05, 0]);
          const viaDefault = await kit.runtime.reflect(ctx, {
            target: { query: { vector: [1, 0, 0], limit: 5, association: null } },
            dryRun: true,
          });
          expect(viaDefault.basis.map((s) => s.memoryId)).toEqual([current]);
          const viaOutside = await kit.runtime.reflect(ctx, {
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
          expect(viaOutside.basis).toEqual([
            { memoryId: expired, kind: "expired", validUntil: PAST },
            { memoryId: current, kind: "eligible" },
          ]);
        }
      });
    });
  }
});
