import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  buildNewMemoryFixture,
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
} from "@mnemora/testkit";
import { installReinforceSpy, type ReinforceCallLog } from "../bench/reinforce-spy.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
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
 * `same-ms-usage-bench.ts`（Issue #730 の手動ベンチ）の測定器そのものの歯。
 *
 * ベンチは `PostgresMemoryStore` の強化の呼び出しを spy で記録し、同じ Memory への強化の
 * `at` が一致する頻度を数える。`runtime.observe({kind:'memory_usage'})` は、#917 以降
 * `reinforceMany`、PR #980 以降 `recordUsageAndReinforce` を通り、`reinforce` を呼ばない。
 * spy が `reinforce` しか見ていないと、使用報告のシナリオ（c/d）の記録が空になり、
 * 「一致0件・母数0」を黙って出す。ここでは、使用報告1回で spy に1件記録されることを測る。
 */
afterAll(async () => {
  await closeTestClient();
});

describe("same-ms-usage-bench の spy は、使用報告の強化を記録する", () => {
  it("observe(memory_usage) を1回撃つと、その Memory・その at で1件記録される", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const spy = installReinforceSpy(memoryStore);
    const at = new Date("2026-09-27T00:00:00.000Z");
    const runtime = createRuntime({
      memoryStore,
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
      hashContent: sha256Hex,
      clock: { now: () => at },
    });
    const ctx: Ctx = { tenantId: "tenant-bench-spy" };
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "bench-spy" }),
    );
    const recallId = await memoryStore.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "bench-spy" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
    });

    const log: ReinforceCallLog[] = [];
    spy.setLog(log);
    await runtime.observe(ctx, { kind: "memory_usage", recallId, usedMemoryIds: [memory.id] });

    expect(log.map((call) => ({ memoryId: call.memoryId, at: call.at.getTime() }))).toEqual([
      { memoryId: memory.id, at: at.getTime() },
    ]);
  });
});
