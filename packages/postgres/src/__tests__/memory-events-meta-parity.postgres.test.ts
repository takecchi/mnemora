import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { ExtractionResultSchema, createRuntime } from "@mnemora/core";
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
 * `memory_events` の meta が、Postgres と testkit の InMemory で同じ形・同じ型になること。
 *
 * - `resolveContested`（`supersede`）で負けた側の `superseded` は、`meta.supersededById` に
 *   勝った側の id を持つ（consolidate・reextract の `superseded` と同じ形。ADR 0150 追記）。
 *   【実測 2026-09-27】以前は2実装とも `{ reason, resolution }` だけだった。
 * - `purgeExpiredEvents` が積む `events_purged` の meta の日時（`oldestPurgedAt`・
 *   `newestPurgedAt`・`olderThan`）は、ISO 8601 の文字列である。
 *   【実測 2026-09-27】Postgres は meta を JSON で保存するので読み戻すと文字列、testkit は
 *   `Date` のまま持っていた。fixture は Postgres を写すものなので、testkit を揃えた。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if ((req.schema as unknown) === ExtractionResultSchema) {
      return req.schema.parse({ memories: [] });
    }
    throw new Error("unexpected schema");
  },
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore,
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
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
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          outboxStore: new PostgresOutboxStore(db),
          vectorStore: new PostgresVectorStore(db),
          eventStore,
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "memory-events-meta-parity" };
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)("memory_events の meta（%s）", (_name, build) => {
  it("resolveContested（supersede）の敗者の superseded は、meta.supersededById に勝者の id を持つ", async () => {
    const { runtime, memoryStore, eventStore } = await build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "meta-parity-a",
        content: "住所は東京",
      }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "meta-parity-b",
        content: "住所は大阪",
      }),
    );
    await runtime.markContested(ctx, a.id, b.id);

    const out = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: b.id,
    });
    expect(out.supported && out.outcome.kind).toBe("resolved");

    const loser = await eventStore.list(ctx, { memoryId: a.id, kind: "superseded" });
    expect(loser).toHaveLength(1);
    expect(loser[0]!.meta).toEqual({
      reason: "contested_resolved",
      resolution: "supersede",
      contestedWithId: b.id,
      supersededById: b.id,
    });
    // 勝者の updated には supersededById を足さない（置き換えられていないため）。相手は
    // contestedWithId で引ける（Issue #1160）。
    const winner = (await eventStore.list(ctx, { memoryId: b.id, kind: "updated" })).filter(
      (e) => e.meta.reason === "contested_resolved",
    );
    expect(winner).toHaveLength(1);
    expect(winner[0]!.meta).toEqual({
      reason: "contested_resolved",
      resolution: "supersede",
      contestedWithId: a.id,
    });
  });

  it("purgeExpiredEvents の events_purged は、meta の日時を ISO 8601 の文字列で持つ", async () => {
    const { runtime, memoryStore, eventStore } = await build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "meta-parity-purge" }),
    );
    await runtime.forget(ctx, { memoryId: a.id });
    const olderThan = new Date(Date.now() + 3_600_000);

    const result = await memoryStore.purgeExpiredEvents!(ctx, { olderThan, limit: 100 });
    expect(result.purged).toBeGreaterThan(0);

    const events = await eventStore.list(ctx, { kind: "events_purged" });
    expect(events).toHaveLength(1);
    const meta = events[0]!.meta;
    expect(meta.purgedCount).toBe(result.purged);
    for (const key of ["oldestPurgedAt", "newestPurgedAt", "olderThan"] as const) {
      expect(typeof meta[key], key).toBe("string");
      expect(meta[key], key).toMatch(ISO_8601);
    }
    expect(meta.olderThan).toBe(olderThan.toISOString());
    // 戻り値のほうは今までどおり Date（型は変えない）。
    expect(result.oldestPurgedAt).toBeInstanceOf(Date);
  });
});
