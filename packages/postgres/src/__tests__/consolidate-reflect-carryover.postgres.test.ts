import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, LLMProvider, Memory, StructuredRequest } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const TENANT = "carryover-tenant";

// `occurredAt` は recall() の freshness/decay 計算に使われる。固定した過去の暦日にすると、実行時の実時刻との差が
// 半減期（既定 720h = 30日）の何倍にもなり、below_threshold に落ちて ANN 到達性の歯が意味を失うので、実時刻からの相対値にする。
const OCCURRED_AT_A = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2時間前
const OCCURRED_AT_B = new Date(Date.now() - 60 * 60 * 1000); // 1時間前（A より新しい）

function llmReturning<T>(result: T): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse(result) as U,
  };
}

async function buildRuntime(memoryStore: PostgresMemoryStore, llmProvider: LLMProvider) {
  const { db } = await getTestClient();
  return createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date(Date.now() + 1_000) },
  });
}

async function seedTwoActiveMemories(memoryStore: PostgresMemoryStore, ctx: Ctx) {
  const a = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "carryover-a",
      content: "本文A",
      subjectId: "subject-shared",
      tags: ["tag-a", "tag-shared"],
      attributes: { visibility: "internal", region: "jp" },
      occurredAt: OCCURRED_AT_A,
    }),
  );
  const b = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "carryover-b",
      content: "本文B",
      subjectId: "subject-shared",
      tags: ["tag-b", "tag-shared"],
      attributes: { visibility: "internal", region: "us" },
      occurredAt: OCCURRED_AT_B,
    }),
  );
  return { a, b };
}

async function labelsFor(memoryStore: PostgresMemoryStore, ctx: Ctx) {
  const labels = (await memoryStore.listLabels?.(ctx)) ?? [];
  return new Map(labels.map((l) => [l.name, l]));
}

describe("runtime.consolidate/reflect — 付随データの引き継ぎ（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("consolidate（atomic 経路）: subjectId・tags 和集合・attributes 積集合・occurredAt 最新・provenance・labels・embed ジョブ・元の supersede が約束どおり", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { a, b } = await seedTwoActiveMemories(memoryStore, ctx);

    const runtime = await buildRuntime(
      memoryStore,
      llmReturning({ content: "統合後の本文" }), // digest/tags 省略 → フォールバック経路
    );

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.outcome).toBe("consolidated");
    expect(result.atomicity).toBe("store_supported");
    const newId = result.consolidatedMemoryId!;

    const created = await memoryStore.get(ctx, newId);
    expect(created).not.toBeNull();
    expect(created!.subjectId).toBe("subject-shared");
    expect(new Set(created!.tags)).toEqual(new Set(["tag-a", "tag-shared", "tag-b"]));
    expect(created!.attributes).toEqual({ visibility: "internal" });
    expect(created!.occurredAt?.toISOString()).toBe(OCCURRED_AT_B.toISOString());
    expect(created!.provenance).toEqual({ kind: "consolidated", sources: [a.id, b.id] });
    expect(created!.sourceObservationId).toBeNull();
    expect(created!.extractorVersion).toBeNull();
    expect(created!.embeddingStatus).toBe("pending");
    expect(created!.strength).toBe(1);

    expect(created!.validFrom).toBeNull();
    expect(created!.validUntil).toBeNull();
    expect(created!.claimKey).toBeNull();

    const aAfter = await memoryStore.get(ctx, a.id);
    const bAfter = await memoryStore.get(ctx, b.id);
    expect(aAfter!.status).toBe("superseded");
    expect(aAfter!.supersededById).toBe(newId);
    expect(aAfter!.content).toBe("本文A");
    expect(bAfter!.status).toBe("superseded");
    expect(bAfter!.supersededById).toBe(newId);

    const labels = await labelsFor(memoryStore, ctx);
    // a・b の作成時にも proposedCount が進んでいるので、tag-shared は a(1) + b(1) + new(1) = 3、tag-a/tag-b は 2。
    expect(labels.get("tag-shared")?.proposedCount).toBe(3);
    expect(labels.get("tag-a")?.proposedCount).toBe(2);
    expect(labels.get("tag-b")?.proposedCount).toBe(2);

    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${TENANT} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
    const readyMemory = await memoryStore.get(ctx, newId);
    expect(readyMemory!.embeddingStatus).toBe("ready");

    const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const embeddingRows = await db.execute(sql`
      SELECT * FROM ${sql.identifier(table)} WHERE tenant_id = ${TENANT} AND memory_id = ${newId}
    `);
    expect(embeddingRows.rows).toHaveLength(1);

    const recallResult = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 10 });
    const recalledIds = recallResult.memories.map((m) => m.memoryId);
    expect(recalledIds).toContain(newId);
    expect(recalledIds).not.toContain(a.id);
    expect(recalledIds).not.toContain(b.id);
  });

  it("consolidate（atomic 経路 vs フォールバック経路）: 結果が同値になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };

    const atomicStore = new PostgresMemoryStore(db);
    const { a: a1, b: b1 } = await seedTwoActiveMemories(atomicStore, ctx);
    const atomicRuntime = await buildRuntime(
      atomicStore,
      llmReturning({ content: "統合後の本文" }),
    );
    const atomicResult = await atomicRuntime.consolidate(ctx, {
      target: { memoryIds: [a1.id, b1.id] },
    });
    expect(atomicResult.atomicity).toBe("store_supported");
    const atomicNew = await atomicStore.get(ctx, atomicResult.consolidatedMemoryId!);
    // ⚠ 次の `resetTestDatabase()` がこのテナントの行を消すため、比較に使う値はここで読み切っておく。
    const aAfter1 = await atomicStore.get(ctx, a1.id);
    const labels1 = await labelsFor(atomicStore, ctx);

    await resetTestDatabase();
    const fallbackStore = new PostgresMemoryStore(db);
    (fallbackStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories = undefined;
    const { a: a2, b: b2 } = await seedTwoActiveMemories(fallbackStore, ctx);
    const fallbackRuntime = await buildRuntime(
      fallbackStore,
      llmReturning({ content: "統合後の本文" }),
    );
    const fallbackResult = await fallbackRuntime.consolidate(ctx, {
      target: { memoryIds: [a2.id, b2.id] },
    });
    expect(fallbackResult.atomicity).toBe("store_unsupported");
    const fallbackNew = await fallbackStore.get(ctx, fallbackResult.consolidatedMemoryId!);

    // `recordedAt`/`decayFloorAt` は呼び出し時点の実時刻由来で、2回の呼び出しの間で数ミリ秒ずれるため、比較から外す。
    function normalize(m: Memory) {
      const { id, createdAt, updatedAt, recordedAt, decayFloorAt, provenance, ...rest } = m;
      return {
        ...rest,
        // provenance.sources は元 memory の id を含み2セットで違うので、kind だけ揃える。
        provenanceKind: (provenance as { kind: string }).kind,
      };
    }
    expect(normalize(atomicNew!)).toEqual(normalize(fallbackNew!));

    const aAfter2 = await fallbackStore.get(ctx, a2.id);
    expect(aAfter1!.status).toBe(aAfter2!.status);
    expect(aAfter1!.supersededById).toBe(atomicResult.consolidatedMemoryId);
    expect(aAfter2!.supersededById).toBe(fallbackResult.consolidatedMemoryId);

    const labels2 = await labelsFor(fallbackStore, ctx);
    expect([...labels1.entries()].sort()).toEqual([...labels2.entries()].sort());
  });

  it("reflect: provenance.kind='reflected' で sources が埋まり、既存の行へは一切書き込まない。attributes は積集合", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { a, b } = await seedTwoActiveMemories(memoryStore, ctx);

    const runtime = await buildRuntime(
      memoryStore,
      llmReturning({ outcome: "reflected", content: "反映結果の本文" }),
    );

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.outcome).toBe("reflected");
    const newId = result.reflectedMemoryId!;

    const created = await memoryStore.get(ctx, newId);
    expect(created!.provenance).toEqual({ kind: "reflected", sources: [a.id, b.id] });
    expect(created!.subjectId).toBe("subject-shared");
    expect(created!.attributes).toEqual({ visibility: "internal" });
    expect(new Set(created!.tags)).toEqual(new Set(["tag-a", "tag-shared", "tag-b"]));
    expect(created!.strength).toBe(1);
    expect(created!.embeddingStatus).toBe("pending");
    expect(created!.validFrom).toBeNull();
    expect(created!.validUntil).toBeNull();
    expect(created!.claimKey).toBeNull();

    const aAfter = await memoryStore.get(ctx, a.id);
    const bAfter = await memoryStore.get(ctx, b.id);
    expect(aAfter!.status).toBe("active");
    expect(aAfter!.supersededById).toBeNull();
    expect(bAfter!.status).toBe("active");
    expect(bAfter!.supersededById).toBeNull();

    const labels = await labelsFor(memoryStore, ctx);
    expect(labels.get("tag-shared")?.proposedCount).toBe(3);

    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${TENANT} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);
    const readyMemory = await memoryStore.get(ctx, newId);
    expect(readyMemory!.embeddingStatus).toBe("ready");
  });

  it("consolidate/reflect: validFrom/validUntil は eligible の区間の積として Postgres を往復する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    // eligible 判定（`classifyValidity`）を通すには、実時刻からの相対値にする必要がある。
    const validFromE = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2時間前
    const validUntilE = new Date(Date.now() + 100 * 60 * 60 * 1000); // 100時間後
    const validFromF = new Date(Date.now() - 30 * 60 * 1000); // 30分前（E より後 ⟹ 積の validFrom）
    const validUntilF = new Date(Date.now() + 50 * 60 * 60 * 1000); // 50時間後（E より前 ⟹ 積の validUntil）

    async function seedEAndF(store: PostgresMemoryStore) {
      const e = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `carryover-validity-e-${Math.random()}`,
          content: "本文E",
          validFrom: validFromE,
          validUntil: validUntilE,
        }),
      );
      const f = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `carryover-validity-f-${Math.random()}`,
          content: "本文F",
          validFrom: validFromF,
          validUntil: validUntilF,
        }),
      );
      return { e, f };
    }

    const { e: e1, f: f1 } = await seedEAndF(memoryStore);
    const consolidateRuntime = await buildRuntime(
      memoryStore,
      llmReturning({ content: "統合後の本文" }),
    );
    const consolidateResult = await consolidateRuntime.consolidate(ctx, {
      target: { memoryIds: [e1.id, f1.id] },
    });
    expect(consolidateResult.outcome).toBe("consolidated");
    const consolidated = await memoryStore.get(ctx, consolidateResult.consolidatedMemoryId!);
    expect(consolidated!.validFrom?.toISOString()).toBe(validFromF.toISOString());
    expect(consolidated!.validUntil?.toISOString()).toBe(validUntilF.toISOString());

    const { e: e2, f: f2 } = await seedEAndF(memoryStore);
    const reflectRuntime = await buildRuntime(
      memoryStore,
      llmReturning({ outcome: "reflected", content: "反映結果の本文" }),
    );
    const reflectResult = await reflectRuntime.reflect(ctx, {
      target: { memoryIds: [e2.id, f2.id] },
    });
    expect(reflectResult.outcome).toBe("reflected");
    const reflected = await memoryStore.get(ctx, reflectResult.reflectedMemoryId!);
    expect(reflected!.validFrom?.toISOString()).toBe(validFromF.toISOString());
    expect(reflected!.validUntil?.toISOString()).toBe(validUntilF.toISOString());
  });

  it("consolidate: subjectId が割れていれば null になる（eligible の主題が一致しない）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "split-a", subjectId: "s1" }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "split-b", subjectId: "s2" }),
    );
    const runtime = await buildRuntime(memoryStore, llmReturning({ content: "統合後" }));
    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const created = await memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created!.subjectId).toBeNull();
  });

  it("consolidate: 新しい行の content は lexical（trigram）チャンネルで直接引ける。元（superseded）は引けない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      // この環境では前提（UTF8 等）が満たせない。`trigram-lexical-store.postgres.test.ts` が別途この否定を検査済みで、ここでは重ねて検査しない。
      return;
    }
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { a, b } = await seedTwoActiveMemories(memoryStore, ctx);
    const runtime = await buildRuntime(
      memoryStore,
      llmReturning({ content: "統合結果のトライグラム照合用本文" }),
    );
    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const newId = result.consolidatedMemoryId!;

    const lexicalStore = await PostgresTrigramLexicalStore.create(db);
    const hits = await lexicalStore.search(ctx, "トライグラム照合用本文", {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    const hitIds = hits.map((h) => h.memoryId);
    expect(hitIds).toContain(newId);
    expect(hitIds).not.toContain(a.id);
    expect(hitIds).not.toContain(b.id);
  });
});
