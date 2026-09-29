import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, NewMemory, Runtime, VectorStore } from "@mnemora/core";
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
 * reflect と reextract が何を材料にし、作った Memory に何を引き継ぐかを、今の振る舞いのまま縛る
 * （`ReflectTarget` と `Runtime.reextract` の TSDoc の 2026-09-27 追記）。約束を足すものではない。
 *
 * - reflect の `{ query }` は、連想枠で返った記憶も材料に採る。
 * - reflect は、いまの時点で有効期間の外にある記憶を材料にしない。内省の Memory は今どおり有効期間を
 *   持たない（Issue #1188。2026-09-29 に「`{ memoryIds }` は有効期間を見ない」から変えた——3つの形
 *   すべての網羅は `reflect-validity-gate.test.ts`（`packages/core`）と
 *   `reflect-target-selection.postgres.test.ts` を見ること。ここでは `{ memoryIds }` の1形だけを、
 *   reextract との組み合わせの文脈で確かめる）。
 * - reextract の新しい Memory は、Observation の有効期間を引き継ぎ、`claimKey` は常に null である。
 * 2実装（Postgres・testkit の InMemory）で同じ結果になることも見る。
 */

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const NOW = new Date("2026-09-27T00:00:00.000Z");
let extractContent = "猫を3匹飼っている";
/** 抽出・claim key・reflect のどのスキーマにも、`safeParse` が通る値を返す偽の LLM。 */
const answers = (): unknown[] => [
  { claims: [{ subject: "user", predicate: "cat_count" }] },
  { outcome: "reflected", content: "内省した本文" },
  { memories: [{ content: extractContent, provenanceKind: "stated" }] },
];

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (
      _ctx: Ctx,
      req: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } },
    ) => {
      for (const value of answers()) {
        const parsed = req.schema.safeParse(value);
        if (parsed.success) return parsed.data as never;
      }
      throw new Error("no fake answer for this schema");
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

const ctx: Ctx = { tenantId: "reflect-reextract-inheritance" };
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
      contentHash: `inherit-${seq}`,
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

describe("reflect・reextract の材料と引き継ぎ（今の振る舞い）", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("reflect の { query } は連想枠で返った記憶も材料に採る", async () => {
        const kit = await makeKit();
        const a = await add(kit, [0, 1, 0]);
        const b = await add(kit, [0.05, 0.95, 0]);
        const c = await add(kit, [0.1, 0.9, 0]);
        const result = await kit.runtime.reflect(ctx, {
          target: { query: { vector: [0, 1, 0], limit: 2 } },
          dryRun: true,
        });
        expect(result.basis).toEqual([
          { memoryId: a, kind: "eligible" },
          { memoryId: b, kind: "eligible" },
          { memoryId: c, kind: "eligible" },
        ]);
      });

      it("reflect の { memoryIds } は、いまの時点で有効期間の外にある記憶を材料にしない（Issue #1188。2026-09-29 変更）。内省の Memory は今どおり有効期間を持たない", async () => {
        const kit = await makeKit();
        const expiredValidUntil = new Date("2026-01-01T00:00:00.000Z");
        const expired = await add(kit, [1, 0, 0], {
          validUntil: expiredValidUntil,
          subjectId: "alice",
        } as Partial<NewMemory>);
        const current = await add(kit, [0.95, 0.05, 0], { subjectId: "alice" });
        const result = await kit.runtime.reflect(ctx, {
          target: { memoryIds: [expired, current] },
        });

        expect(result.outcome).toBe("reflected");
        expect(result.basis).toEqual([
          { memoryId: expired, kind: "expired", validUntil: expiredValidUntil },
          { memoryId: current, kind: "used" },
        ]);
        const reflected = await kit.memoryStore.get(ctx, result.reflectedMemoryId!);
        expect(reflected?.status).toBe("active");
        expect(reflected?.validUntil ?? null).toBeNull();
        expect(reflected?.subjectId).toBe("alice");
        expect(reflected?.provenance).toEqual({ kind: "reflected", sources: [current] });
        expect((await kit.memoryStore.get(ctx, expired))?.status).toBe("active");
      });

      it("reextract の新しい Memory は Observation の有効期間を引き継ぎ、claimKey は null", async () => {
        const kit = await makeKit();
        extractContent = "猫を3匹飼っている";
        const observed = await kit.runtime.observe(ctx, {
          kind: "utterance",
          text: "猫は3匹だよ",
          validUntil: new Date("2026-12-31T00:00:00.000Z"),
          claimKey: { enabled: true },
        } as never);
        const original = await kit.memoryStore.get(ctx, observed.memoryIds[0]!);
        expect(original?.claimKey).toEqual({ subject: "user", predicate: "cat_count" });

        extractContent = "猫を3匹飼っています";
        const reextracted = await kit.runtime.reextract(ctx, observed.observationId);
        expect(reextracted.supersededMemoryIds).toEqual([original!.id]);
        const replacement = await kit.memoryStore.get(ctx, reextracted.memoryIds[0]!);
        expect(replacement?.status).toBe("active");
        expect(replacement?.validUntil?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
        expect(replacement?.claimKey ?? null).toBeNull();
        expect((await kit.memoryStore.get(ctx, original!.id))?.claimKey).toEqual({
          subject: "user",
          predicate: "cat_count",
        });
      });
    });
  }
});
