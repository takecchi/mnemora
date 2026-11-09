import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

// ADR 0702: `at` は各プロセスの時計の値なので、時計のずれたワーカーが混ざると `at` の順は遷移の順と食い違う。
// `seq`（store が記録した順）で並べれば、同じ記憶の履歴は遷移の順に戻る。

const ctx: Ctx = { tenantId: "event-seq-clock-skew" };
const T0 = new Date("2026-06-01T00:00:00.000Z");
const unusedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("LLM は使わない");
  },
  completeStructured: async () => {
    throw new Error("LLM は使わない");
  },
};

/** 時計が `skewMs` だけ進んだワーカー（同じ DB を見る別プロセスの代わり）。 */
async function worker(skewMs: number) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const eventStore = new PostgresEventStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore,
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: unusedLlm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_c, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (c: string) => `sha256(${c})`,
    clock: { now: () => new Date(T0.getTime() + skewMs) },
  });
  return { memoryStore, eventStore, runtime };
}

describe("memory_events.seq: 時計のずれたワーカーが混ざっても、seq の順は遷移の順（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("10秒進んだワーカーが archive し、その後1秒進んだワーカーが restore すると、at の順は逆になるが seq の順は遷移の順", async () => {
    await resetTestDatabase();
    const sweeper = await worker(10_000);
    const api = await worker(1_000);
    const memory = await sweeper.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `h-${randomUUID()}`,
        status: "active",
        decayFloorAt: T0,
      }),
    );

    const swept = await sweeper.runtime.sweepArchive(ctx, {
      now: new Date(T0.getTime() + 10_000),
      limit: 10,
      clock: "wall",
    });
    expect(swept.archived.map((a) => a.memoryId)).toEqual([memory.id]);
    await api.runtime.restoreArchived(ctx, { memoryId: memory.id });

    const final = await api.memoryStore.get(ctx, memory.id);
    expect(final?.status).toBe("active");

    const events = await api.eventStore.list(ctx, { memoryId: memory.id });
    // at の順（list の並び）では restore が先に来て、最後のイベントから最終状態を読むと誤る。
    expect(events.map((e) => e.kind)).toEqual(["restored", "archived"]);
    // seq の順では遷移の順に戻り、最後のイベントが最終状態と一致する。
    const bySeq = [...events].sort((a, b) => a.seq! - b.seq!);
    expect(bySeq.map((e) => e.kind)).toEqual(["archived", "restored"]);
  });

  it("forget のイベントは meta.previousStatus に直前の status を持つ", async () => {
    await resetTestDatabase();
    const { memoryStore, eventStore, runtime } = await worker(0);
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `f-${randomUUID()}`,
        status: "archived",
      }),
    );

    await runtime.forget(ctx, { memoryId: memory.id });

    const [event] = await eventStore.list(ctx, { memoryId: memory.id, kind: "forgotten" });
    expect(event?.meta).toEqual({ previousStatus: "archived" });
  });
});
