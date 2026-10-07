import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider } from "@mnemora/core";
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

const ctx: Ctx = { tenantId: "restore-archived-writes" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

async function setup() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: notUsedLlm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { db, memoryStore, runtime };
}

interface EventRow {
  memory_id: string;
  kind: string;
  at: string;
  actor: unknown;
  digest_snapshot: string | null;
  meta: Record<string, unknown>;
}

async function restoredEvents(db: Awaited<ReturnType<typeof getTestClient>>["db"]) {
  const result = await db.execute(sql`
    SELECT memory_id, kind, at, actor, digest_snapshot, meta
    FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND kind = 'restored'
  `);
  return result.rows as unknown as EventRow[];
}

describe("restoreArchived が Postgres に書くもの", () => {
  beforeEach(async () => {
    // `setup()` が reset する。
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("restored イベントは対象の記憶に1件だけ、時計の now・渡した actor・復帰前の digest・渡した reason を持って積まれる", async () => {
    const { db, memoryStore, runtime } = await setup();
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `t-${randomUUID()}`,
        status: "archived",
        digest: "復帰前の要旨",
      }),
    );

    await runtime.restoreArchived(
      ctx,
      { memoryId: target.id },
      { reason: "必要になった", actor: { type: "human", id: "alice" } },
    );

    const events = await restoredEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      memory_id: target.id,
      actor: { type: "human", id: "alice" },
      digest_snapshot: "復帰前の要旨",
      meta: { reason: "必要になった" },
    });
    expect(new Date(events[0]!.at)).toEqual(NOW);
  });

  it("reason を渡さなければ meta に reason キーは無く、actor は system になる", async () => {
    const { db, memoryStore, runtime } = await setup();
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `t-${randomUUID()}`,
        status: "archived",
      }),
    );

    await runtime.restoreArchived(ctx, { memoryId: target.id });

    const [event] = await restoredEvents(db);
    expect(event?.meta).toEqual({});
    expect(event?.actor).toEqual({ type: "system" });
  });

  it("同じテナントの archived な別の記憶は archived のまま、イベントも積まれない。復帰した記憶の本文・要旨も変わらない", async () => {
    const { db, memoryStore, runtime } = await setup();
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `t-${randomUUID()}`,
        status: "archived",
        content: "復帰する記憶の本文",
        digest: "復帰する記憶の要旨",
      }),
    );
    const bystander = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `b-${randomUUID()}`,
        status: "archived",
      }),
    );

    await runtime.restoreArchived(ctx, { memoryId: target.id });

    expect((await memoryStore.get(ctx, bystander.id))?.status).toBe("archived");
    const restored = await memoryStore.get(ctx, target.id);
    expect(restored?.status).toBe("active");
    expect(restored?.content).toBe("復帰する記憶の本文");
    expect(restored?.digest).toBe("復帰する記憶の要旨");
    expect((await restoredEvents(db)).map((e) => e.memory_id)).toEqual([target.id]);
  });
});
