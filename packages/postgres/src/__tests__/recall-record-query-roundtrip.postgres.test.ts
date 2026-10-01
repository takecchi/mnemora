import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, RecallRecord, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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
 * `getRecall` が読み戻す `query` の、JSON で往復しない値の今の振る舞いを縛る（Issue #1206。
 * `RecallRecord.query` の doc の 2026-09-27 追記）。振る舞いは変えていない。
 *
 * `recall()` は検証した後のクエリをそのまま記録する。`RecallQuerySchema` が `Date` にする3欄
 * （`occurredAfter`・`occurredBefore`・`validAt`）は、`@mnemora/postgres` では ISO 文字列で、
 * testkit の fixture では `Date` のまま読み戻る。`vector` の `-0` は Postgres だけ `0` になる。
 * `budget` はどちらも返り値と同じ（`omitted` などの残りの欄は `recall-explain-accounting.postgres.test.ts`）。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const OCCURRED_AFTER = new Date("2020-01-01T00:00:00.000Z");
const OCCURRED_BEFORE = new Date("2030-01-01T00:00:00.000Z");
const VALID_AT = new Date("2026-09-26T00:00:00.000Z");

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => NOW },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

const ctx: Ctx = { tenantId: "recall-record-query-roundtrip" };

async function recallAndReadBack(kit: Kit): Promise<RecallRecord> {
  const result = await kit.runtime.recall(ctx, {
    text: "本文",
    vector: [-0, 1, 0],
    occurredAfter: OCCURRED_AFTER,
    occurredBefore: OCCURRED_BEFORE,
    validAt: VALID_AT,
    budget: { maxMemoryChars: 1000 },
    limit: 3,
    association: null,
  });
  const record = await kit.runtime.getRecall(ctx, result.recallId);
  expect(record).not.toBeNull();
  expect(record!.budget).toEqual({ maxMemoryChars: 1000 });
  return record!;
}

afterAll(async () => {
  await closeTestClient();
});

describe("getRecall が読み戻す query の、JSON で往復しない値（今の振る舞い）", () => {
  it("testkit の fixture: 日付の3欄は Date のまま、vector の -0 も -0 のまま読み戻る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const record = await recallAndReadBack({
      memoryStore,
      runtime: createRuntime({
        ...shared,
        memoryStore,
        vectorStore: new InMemoryVectorStore(memoryStore),
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      }),
    });
    const query = record.query as Record<string, unknown>;
    expect(query.occurredAfter).toBeInstanceOf(Date);
    expect(query.occurredAfter).toEqual(OCCURRED_AFTER);
    expect(query.occurredBefore).toEqual(OCCURRED_BEFORE);
    expect(query.validAt).toEqual(VALID_AT);
    expect(Object.is((query.vector as number[])[0], -0)).toBe(true);
  });

  it("Postgres: 日付の3欄は ISO 文字列で、vector の -0 は 0 で読み戻る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const record = await recallAndReadBack({
      memoryStore,
      runtime: createRuntime({
        ...shared,
        memoryStore,
        vectorStore: new PostgresVectorStore(db),
        eventStore: new PostgresEventStore(db),
        outboxStore: new PostgresOutboxStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      }),
    });
    const query = record.query as Record<string, unknown>;
    expect(query.occurredAfter).toBe(OCCURRED_AFTER.toISOString());
    expect(query.occurredBefore).toBe(OCCURRED_BEFORE.toISOString());
    expect(query.validAt).toBe(VALID_AT.toISOString());
    expect(Object.is((query.vector as number[])[0], 0)).toBe(true);
  });
});

const NEW_RECALL = {
  tenantId: ctx.tenantId,
  subjectId: null,
  query: { text: "q" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

describe("createRecall の createdAt が Invalid Date（ADR 0480）", () => {
  it("Postgres は拒む（timestamptz に入らない）。何も書かない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await expect(
      store.createRecall(ctx, { ...NEW_RECALL, createdAt: new Date(Number.NaN) }),
    ).rejects.toThrow();
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM recalls`);
    expect((count.rows[0] as unknown as { n: number }).n).toBe(0);
  });

  it("testkit の fixture も拒み、何も書かない。有効な日付は受ける（陽性対照）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createRecall(ctx, { ...NEW_RECALL, createdAt: new Date(Number.NaN) }),
    ).rejects.toThrow(/createdAt must be a valid Date/);
    const id = await store.createRecall(ctx, {
      ...NEW_RECALL,
      createdAt: new Date("2026-01-01T00:00:00.123Z"),
    });
    expect((await store.getRecall(ctx, id))?.createdAt.toISOString()).toBe(
      "2026-01-01T00:00:00.123Z",
    );
  });
});

describe("getRecall の id（ADR 0480 の照合。今の振る舞い）", () => {
  it("Postgres: 大文字は同じ行を引き、小文字の recallId を返す。壊れた形・別テナントは null", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const id = await store.createRecall(ctx, NEW_RECALL);
    expect((await store.getRecall(ctx, id.toUpperCase()))?.recallId).toBe(id);
    for (const bad of [` ${id} `, `{${id}}`, id.replace(/-/g, ""), `${id}\u0000`, ""]) {
      expect(await store.getRecall(ctx, bad)).toBeNull();
    }
    expect(await store.getRecall({ tenantId: "other" }, id)).toBeNull();
  });
});
