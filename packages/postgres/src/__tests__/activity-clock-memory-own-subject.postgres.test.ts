import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import {
  createRuntime,
  defaultActivityDecayStrategy,
  DEFAULT_HALF_LIFE_RECALLS,
} from "@mnemora/core";
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
 * [ADR 0394](../../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)
 * （ADR 0353 の負債1の解消）を、本物の Postgres の列（`decay_base_seq`/`decay_floor_seq`）で確かめる。
 *
 * 書く側の活動時計の「いま」は、対象の Memory 自身の subject の `T + S_x`（読む側の段1 SQL・
 * `archiveDecayed` が行ごとに足す式と同じ）でなければならない。`ctx` と Memory の subject が
 * ずれる形（tick のように subjectId の無い ctx／ctx=alice で bob の記憶／ctx=alice で主題なしの記憶）で、
 * 作成（抽出）と強化（使用報告・`restoreArchived`）の両方を確かめる。
 *
 * 数値は T=10・S_alice=7・S_bob=20（有効ないま: alice=17, bob=30, 主題なし=10）。
 */

const TENANT = "own-subject-tenant";
const tenantCtx: Ctx = { tenantId: TENANT };
const aliceCtx: Ctx = { tenantId: TENANT, subjectId: "alice" };
const NOW_ALICE = 17;
const NOW_BOB = 30;
const NOW_NONE = 10;

afterAll(async () => {
  await closeTestClient();
});

function llmReturning(memories: unknown[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse({ memories }) as U,
  };
}

const recallInput = {
  tenantId: TENANT,
  query: { text: "q" },
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

async function setup(llmProvider: LLMProvider) {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore,
    llmProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    // outbox の available_at は DB の now()。runtime の時計を少し先にして、積んだ直後の tick が claim できるようにする。
    clock: { now: () => new Date(Date.now() + 1_000) },
  });
  await tenantSettingsStore.setDecayClock(tenantCtx, "activity");
  for (let i = 0; i < 10; i += 1) {
    await memoryStore.createRecall(tenantCtx, {
      ...recallInput,
      subjectId: null,
      advanceActivityClock: true,
    });
  }
  for (const [subjectId, n] of [
    ["alice", 7],
    ["bob", 20],
  ] as const) {
    for (let i = 0; i < n; i += 1) {
      await memoryStore.createRecall(tenantCtx, {
        ...recallInput,
        subjectId,
        advanceActivityClock: { scope: "subject", subjectId },
      });
    }
  }
  expect(await tenantSettingsStore.getActivitySeq(tenantCtx)).toBe(10);
  expect(await tenantSettingsStore.getSubjectActivitySeqs(tenantCtx, ["alice", "bob"])).toEqual({
    alice: 7,
    bob: 20,
  });
  return { db, memoryStore, runtime };
}

/** 生の列を読む（mapping を通さず、DB に入った値そのものを見る）。 */
async function readOrigin(
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
  memoryId: string,
): Promise<{ base: number; floor: number; halfLife: number }> {
  const result = await db.execute(sql`
    SELECT decay_base_seq::float8 AS base, decay_floor_seq::float8 AS floor,
           half_life_recalls::float8 AS half_life
    FROM memories WHERE tenant_id = ${TENANT} AND id = ${memoryId}
  `);
  const row = result.rows[0] as { base: number; floor: number; half_life: number };
  return { base: row.base, floor: row.floor, halfLife: row.half_life };
}

function floorFrom(baseSeq: number, halfLifeRecalls: number): number {
  return defaultActivityDecayStrategy.floorAt({ baseSeq, strength: 1, halfLifeRecalls });
}

describe("ADR 0394: 書く側の活動時計の「いま」は、記憶自身の subject の T + S_x（Postgres の列）", () => {
  it("PostgresMemoryStore は addOwnSubjectSeq を読めることを宣言している（宣言が外れると runtime は T + S_ctx を渡し、適合テストの歯も skip される）", async () => {
    const { db } = await getTestClient();
    expect(new PostgresMemoryStore(db).supportsAddOwnSubjectSeq?.()).toBe(true);
  });

  it("作成（deferred 抽出）: subjectId の無い ctx（tick）から alice の記憶を作ると、decay_base_seq = T + S_alice", async () => {
    const { db, runtime } = await setup(
      llmReturning([{ content: "aliceの事実", provenanceKind: "stated" }]),
    );
    const { observationId } = await runtime.observe(aliceCtx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    const tick = await runtime.tick(tenantCtx, { kinds: ["extract"], leaseMs: 60_000 });
    expect(tick.processed).toBe(1);
    const found = await db.execute(sql`
      SELECT id, subject_id FROM memories
      WHERE tenant_id = ${TENANT} AND source_observation_id = ${observationId}
    `);
    expect(found.rows).toHaveLength(1);
    const row = found.rows[0] as { id: string; subject_id: string };
    expect(row.subject_id).toBe("alice");
    const origin = await readOrigin(db, row.id);
    expect(origin.base).toBe(NOW_ALICE);
    expect(origin.halfLife).toBe(DEFAULT_HALF_LIFE_RECALLS);
    expect(origin.floor).toBe(floorFrom(NOW_ALICE, DEFAULT_HALF_LIFE_RECALLS));
  });

  it("作成（同期抽出）: ctx=alice で bob の記憶（candidate.subjectId=bob）と主題なしの記憶（null）を作ると、それぞれ T + S_bob・T", async () => {
    const { db, runtime } = await setup(
      llmReturning([
        { content: "bobの事実", provenanceKind: "stated", subjectId: "bob" },
        { content: "主題なしの事実", provenanceKind: "stated", subjectId: null },
        { content: "aliceの事実", provenanceKind: "stated" },
      ]),
    );
    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    expect(result.memoryIds).toHaveLength(3);
    const seen = new Map<string | null, number>();
    for (const id of result.memoryIds) {
      const r = await db.execute(sql`
        SELECT subject_id, decay_base_seq::float8 AS base FROM memories
        WHERE tenant_id = ${TENANT} AND id = ${id}
      `);
      const row = r.rows[0] as { subject_id: string | null; base: number };
      seen.set(row.subject_id, row.base);
    }
    expect(seen.get("bob")).toBe(NOW_BOB);
    expect(seen.get(null)).toBe(NOW_NONE);
    // 制御: ctx と subject が一致する候補。
    expect(seen.get("alice")).toBe(NOW_ALICE);
  });

  it("強化（使用報告）: subjectId の無い ctx から alice・bob・主題なしの記憶をまとめて強化すると、行ごとに自身の subject の T + S_x（recordUsageAndReinforce の1トランザクション）", async () => {
    const { db, memoryStore, runtime } = await setup(llmReturning([]));
    const seed = async (subjectId: string | null, hash: string) =>
      memoryStore.createMemory(
        tenantCtx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: hash,
          subjectId,
          strength: 1,
          halfLifeRecalls: 360,
          decayBaseSeq: 0,
          decayFloorSeq: 10,
        }),
      );
    const alice = await seed("alice", "usage-a");
    const bob = await seed("bob", "usage-b");
    const none = await seed(null, "usage-n");
    const recallId = await memoryStore.createRecall(tenantCtx, { ...recallInput, subjectId: null });

    await runtime.observe(tenantCtx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [alice.id, bob.id, none.id],
      externalId: "own-subject-usage",
    });

    for (const [id, expected] of [
      [alice.id, NOW_ALICE],
      [bob.id, NOW_BOB],
      [none.id, NOW_NONE],
    ] as const) {
      const origin = await readOrigin(db, id);
      expect(origin.base).toBe(expected);
      expect(origin.floor).toBe(floorFrom(expected, 360));
    }
  });

  it("強化（restoreArchived）: ctx=alice で bob の記憶を復帰させると、decay_base_seq = T + S_bob", async () => {
    const { db, memoryStore, runtime } = await setup(llmReturning([]));
    const bob = await memoryStore.createMemory(
      tenantCtx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "restore-b",
        subjectId: "bob",
        status: "archived",
        strength: 1,
        halfLifeRecalls: 360,
        decayBaseSeq: 0,
        decayFloorSeq: 10,
      }),
    );
    const result = await runtime.restoreArchived(aliceCtx, { memoryId: bob.id });
    expect(result.outcomes[0]?.kind).toBe("restored");
    const origin = await readOrigin(db, bob.id);
    expect(origin.base).toBe(NOW_BOB);
    expect(origin.floor).toBe(floorFrom(NOW_BOB, 360));
  });
});
