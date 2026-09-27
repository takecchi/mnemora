import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  buildNewMemoryFixture,
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
} from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * Issue #1136: `consolidate` / `reflect` の `{ seedMemoryId }` 形は、種が forget・purge された
 * 記憶なら近傍を集めない。forget と purge は、利用者が「使わないでほしい」と言った記憶である。
 * その `digest` を検索語にして近傍を束ねると、消した情報が別の形で効き続ける（#897 / ADR 0124 が
 * observe の再送で「消した情報が蘇るので抽出をやり直さない」と決めたのと同じ線。クローン miku の
 * 判断）。対象は種1件だけになり、種が見つからないときと同じく既存の分類
 * （`status_not_active(forgotten)` → `no_eligible_sources` / `no_eligible_basis`）に落ちる。
 *
 * 直接呼び出しと自動 job（`tick` 経由、ADR 0157）の両方を、Postgres と testkit の fixture で当てる。
 * 近傍は種と同じ本文にして（決定的な埋め込みで類似度 1）、既定の `minAffinity` でも確実に拾われる
 * 形にしてある——直す前は、近傍2件が統合・内省されていた（赤）。
 */

type Backend = "postgres" | "testkit";

const CONTENT = "猫が好き";
let tenantSeq = 0;

async function setup(backend: Backend) {
  let stores;
  if (backend === "postgres") {
    const { db } = await getTestClient();
    stores = {
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      lexicalStore: new PostgresLexicalStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
  } else {
    const memoryStore = new InMemoryMemoryStore();
    stores = {
      memoryStore,
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      vectorStore: new InMemoryVectorStore(memoryStore),
      lexicalStore: new InMemoryLexicalStore(memoryStore),
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      tenantSettingsStore: new InMemoryTenantSettingsStore(),
    };
  }
  // outbox の `available_at` は実時計で埋まるので、時計はそれより後に置く。
  const now = new Date(Date.now() + 86_400_000);
  const runtime: Runtime = createRuntime({
    ...stores,
    llmProvider: new DeterministicLLMProvider(),
    embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
    hashContent: sha256Hex,
    clock: { now: () => now },
  });
  const ctx: Ctx = { tenantId: `forgotten-seed-${backend}-${++tenantSeq}` };
  const make = async (name: string, jobKinds: string[]): Promise<MemoryId> => {
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: CONTENT,
        digest: CONTENT,
        contentHash: `${name}-${tenantSeq}`,
        recordedAt: now,
        decayFloorAt: new Date(now.getTime() + 1e12),
      }),
      jobKinds,
    );
    return memory.id;
  };
  return { stores, runtime, ctx, make };
}

describe("Issue #1136: forget・purge された種は近傍を集めない（consolidate / reflect、直接と自動 job）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  for (const backend of ["postgres", "testkit"] as const) {
    for (const op of ["consolidate", "reflect"] as const) {
      for (const mode of ["direct", "job"] as const) {
        for (const seedState of ["forgotten", "purged"] as const) {
          it(`${backend} / ${op} / ${mode} / 種が ${seedState}: 近傍は束ねられず、新しい記憶もできない`, async () => {
            if (backend === "postgres") await resetTestDatabase();
            const { stores, runtime, ctx, make } = await setup(backend);
            const seed = await make("seed", mode === "job" ? ["embed", op] : ["embed"]);
            const neighbors = [await make("b", ["embed"]), await make("c", ["embed"])];
            await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["embed"], limit: 100 });
            await runtime.forget(ctx, { memoryId: seed });
            if (seedState === "purged") await runtime.purge(ctx, { memoryId: seed });

            if (mode === "direct") {
              if (op === "consolidate") {
                const result = await runtime.consolidate(ctx, { target: { seedMemoryId: seed } });
                expect(result).toMatchObject({
                  outcome: "nothing_to_consolidate",
                  nothingReason: "no_eligible_sources",
                  consolidatedMemoryId: null,
                  atomicity: "not_attempted",
                  llmCalls: 0,
                });
                expect(result.sources).toEqual([
                  { memoryId: seed, kind: "status_not_active", status: "forgotten" },
                ]);
              } else {
                const result = await runtime.reflect(ctx, { target: { seedMemoryId: seed } });
                expect(result).toMatchObject({
                  outcome: "nothing_to_reflect",
                  nothingReason: "no_eligible_basis",
                  reflectedMemoryId: null,
                  llmCalls: 0,
                });
                expect(result.basis).toEqual([
                  { memoryId: seed, kind: "status_not_active", status: "forgotten" },
                ]);
              }
            } else {
              const tick = await runtime.tick(ctx, { leaseMs: 60_000, kinds: [op] });
              expect(tick).toMatchObject({ processed: 1, failed: 0 });
            }

            for (const id of neighbors) {
              expect((await stores.memoryStore.get(ctx, id))?.status).toBe("active");
            }
            const created = await stores.eventStore.list(ctx, { kind: "created" });
            expect(created).toEqual([]);
          });
        }
      }
    }
  }

  it("対照: 種が active なら、同じ近傍を今どおり束ねる（歯が近傍を拾える構成であること）", async () => {
    await resetTestDatabase();
    const { runtime, ctx, make } = await setup("postgres");
    const seed = await make("seed", ["embed"]);
    await make("b", ["embed"]);
    await make("c", ["embed"]);
    await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["embed"], limit: 100 });
    const result = await runtime.consolidate(ctx, { target: { seedMemoryId: seed } });
    expect(result.outcome).toBe("consolidated");
    expect(result.sources.filter((s) => s.kind === "superseded")).toHaveLength(3);
  });
});
