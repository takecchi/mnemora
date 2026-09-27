import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryId } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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
 * `runtime.restoreSuperseded` の往復数は、戻す群の大きさに比例しない。
 *
 * 群の復帰そのものは `MemoryStore.restoreSupersededBy?` の SQL 1本である。
 * 【実測 2026-09-27】以前は、戻した後の強化を1件ずつ `reinforce` で呼んでいたため、
 * 群が1件増えるごとに往復が2つ増えていた（群 2 / 6 / 21 件で 6 / 14 / 44 往復）。
 * 使用報告（`observe({kind:'memory_usage'})`）が Issue #874 で `reinforceMany?` に束ねたのと
 * 同じ形で束ねる。
 *
 * 固定するのは「群の大きさを変えても往復数が等しい」ことだけで、往復数そのもの
 * （実装の細部で動く値）は固定しない——`recall-roundtrip-count.postgres.test.ts` と同じ考え方。
 */

const ctx: Ctx = { tenantId: "restore-superseded-roundtrip" };

async function countClientQueries(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    count += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return count;
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => req.schema.parse({ content: "統合した本文" }),
};

/** `groupSize` 件を consolidate で1つにまとめ、その群を restoreSuperseded で戻す往復数を数える。 */
async function roundtripsToRestore(
  groupSize: number,
): Promise<{ trips: number; restored: number }> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
  });
  const ids: MemoryId[] = [];
  for (let i = 0; i < groupSize; i += 1) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `group-${groupSize}-${i}` }),
    );
    ids.push(memory.id);
  }
  const consolidated = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
  let restored = 0;
  const trips = await countClientQueries(async () => {
    const result = await runtime.restoreSuperseded(ctx, {
      supersededById: consolidated.consolidatedMemoryId!,
    });
    restored = result.outcomes.filter((o) => o.kind === "restored" && !o.reinforceError).length;
  });
  return { trips, restored };
}

describe("restoreSuperseded の往復数は群の大きさに比例しない（本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("群 2 件と 11 件で往復数が等しい（どちらも全件が restored・強化の失敗なし）", async () => {
    const small = await roundtripsToRestore(2);
    const large = await roundtripsToRestore(11);
    // 意味のある比較であることの検算: 実際に群の全件が戻っている。
    expect(small.restored).toBe(2);
    expect(large.restored).toBe(11);
    expect(large.trips).toBe(small.trips);
  });
});
