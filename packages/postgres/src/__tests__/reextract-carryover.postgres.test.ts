import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 「記憶を作り替える操作の後の付随データの引き継ぎ」バグ探し——`runtime.reextract`
 * （新しい記憶を作る系のもう1つの経路）を、本物の Postgres で端から端で検査する。
 *
 * `reextract` は `extraction.ts` の `buildNewMemoryFromCandidate` をそのまま使う
 * （`consolidate`/`reflect` 専用の `buildConsolidatedMemory`/`buildReflectedMemory` とは違う
 * ——`runtime.ts` の `buildNewMemoriesForCandidates` 参照）。⟹ `validFrom`/`validUntil`/
 * `attributes` は Observation からの素通し（Issue #280/#152、ADR 0312）が約束であり、
 * consolidate/reflect の「約束が無い」とは対称ではない。ここではその約束が実際に
 * Postgres 往復で守られているかを検査する。
 */

const TENANT = "reextract-carryover-tenant";

function llmExtractingTo(memories: Array<Record<string, unknown>>): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories }) as T,
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
  });
}

async function labelsFor(memoryStore: PostgresMemoryStore, ctx: Ctx) {
  const labels = (await memoryStore.listLabels?.(ctx)) ?? [];
  return new Map(labels.map((l) => [l.name, l]));
}

describe("runtime.reextract — 付随データの引き継ぎ（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("validFrom/validUntil/attributes は Observation からそのまま引き継がれ、claimKey は既定で null。labels・embed ジョブも作られる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const validFrom = new Date(Date.now() - 60 * 60 * 1000);
    const validUntil = new Date(Date.now() + 60 * 60 * 1000);
    const observation = await memoryStore.createObservation(ctx, {
      tenantId: TENANT,
      kind: "utterance",
      payload: { text: "reextract 対象の発話" },
      occurredAt: new Date(),
      recordedAt: new Date(),
      validFrom,
      validUntil,
      attributes: { visibility: "internal" },
    });

    const runtime = await buildRuntime(
      memoryStore,
      llmExtractingTo([{ content: "抽出結果1", tags: ["tag-x"], provenanceKind: "stated" }]),
    );

    const result = await runtime.reextract(ctx, observation.id);
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
    expect(result.atomicity).toBe("store_supported");

    const created = await memoryStore.get(ctx, result.memoryIds[0]!);
    expect(created).not.toBeNull();
    // Issue #280: Observation から素通し(約束あり——consolidate/reflect とは対称ではない)。
    expect(created!.validFrom?.toISOString()).toBe(validFrom.toISOString());
    expect(created!.validUntil?.toISOString()).toBe(validUntil.toISOString());
    // Issue #152/#153（ADR 0312）: Observation の attributes をそのまま継承する。
    expect(created!.attributes).toEqual({ visibility: "internal" });
    // claim key 導出（opt-in）を使っていないので既定で null。
    expect(created!.claimKey).toBeNull();
    expect(created!.sourceObservationId).toBe(observation.id);
    expect(created!.embeddingStatus).toBe("pending");

    // labels: 新しい行の tags から proposed ラベルが作られている。
    const labels = await labelsFor(memoryStore, ctx);
    expect(labels.get("tag-x")?.proposedCount).toBe(1);

    // embed ジョブ → tick → ready。
    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${TENANT} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);
    const ready = await memoryStore.get(ctx, result.memoryIds[0]!);
    expect(ready!.embeddingStatus).toBe("ready");
  });

  it("同じ Observation を内容を変えて2回目 reextract すると、1回目の Memory が superseded になり、新しい Memory も同じ約束を守る（atomic 経路）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const observation = await memoryStore.createObservation(ctx, {
      tenantId: TENANT,
      kind: "utterance",
      payload: { text: "2回目の reextract 対象" },
      occurredAt: new Date(),
      recordedAt: new Date(),
      attributes: { visibility: "public" },
    });

    const runtime1 = await buildRuntime(
      memoryStore,
      llmExtractingTo([{ content: "初回抽出", tags: ["v1"], provenanceKind: "stated" }]),
    );
    const first = await runtime1.reextract(ctx, observation.id);
    expect(first.memoryIds).toHaveLength(1);
    const firstMemoryId = first.memoryIds[0]!;

    const runtime2 = await buildRuntime(
      memoryStore,
      llmExtractingTo([{ content: "2回目の抽出", tags: ["v2"], provenanceKind: "stated" }]),
    );
    const second = await runtime2.reextract(ctx, observation.id);
    expect(second.atomicity).toBe("store_supported");
    expect(second.memoryIds).toHaveLength(1);
    expect(second.supersededMemoryIds).toEqual([firstMemoryId]);

    const firstAfter = await memoryStore.get(ctx, firstMemoryId);
    expect(firstAfter!.status).toBe("superseded");
    expect(firstAfter!.supersededById).toBe(second.memoryIds[0]);

    const secondMemory = await memoryStore.get(ctx, second.memoryIds[0]!);
    expect(secondMemory!.attributes).toEqual({ visibility: "public" });
    expect(secondMemory!.sourceObservationId).toBe(observation.id);
  });

  it("reextract（atomic 経路 vs フォールバック経路）: 新規作成・supersede・labels が同値になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };

    // --- atomic 経路 ---
    const atomicStore = new PostgresMemoryStore(db);
    const obs1 = await atomicStore.createObservation(ctx, {
      tenantId: TENANT,
      kind: "utterance",
      payload: { text: "同値性チェック用" },
      attributes: { region: "jp" },
    });
    const atomicRuntime1 = await buildRuntime(
      atomicStore,
      llmExtractingTo([{ content: "初回", tags: ["t1"], provenanceKind: "stated" }]),
    );
    const atomicFirst = await atomicRuntime1.reextract(ctx, obs1.id);
    const atomicRuntime2 = await buildRuntime(
      atomicStore,
      llmExtractingTo([{ content: "更新後", tags: ["t2"], provenanceKind: "stated" }]),
    );
    const atomicSecond = await atomicRuntime2.reextract(ctx, obs1.id);
    expect(atomicSecond.atomicity).toBe("store_supported");
    const atomicNew = await atomicStore.get(ctx, atomicSecond.memoryIds[0]!);
    const atomicOldAfter = await atomicStore.get(ctx, atomicFirst.memoryIds[0]!);
    const atomicLabels = await labelsFor(atomicStore, ctx);

    // --- フォールバック経路（口を外した Postgres store、別テナントで隔離） ---
    const FALLBACK_TENANT = "reextract-carryover-tenant-fallback";
    const fallbackCtx: Ctx = { tenantId: FALLBACK_TENANT };
    const fallbackStore = new PostgresMemoryStore(db);
    (fallbackStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories = undefined;
    const obs2 = await fallbackStore.createObservation(fallbackCtx, {
      tenantId: FALLBACK_TENANT,
      kind: "utterance",
      payload: { text: "同値性チェック用" },
      attributes: { region: "jp" },
    });
    const fallbackRuntime1 = await buildRuntime(
      fallbackStore,
      llmExtractingTo([{ content: "初回", tags: ["t1"], provenanceKind: "stated" }]),
    );
    const fallbackFirst = await fallbackRuntime1.reextract(fallbackCtx, obs2.id);
    const fallbackRuntime2 = await buildRuntime(
      fallbackStore,
      llmExtractingTo([{ content: "更新後", tags: ["t2"], provenanceKind: "stated" }]),
    );
    const fallbackSecond = await fallbackRuntime2.reextract(fallbackCtx, obs2.id);
    expect(fallbackSecond.atomicity).toBe("store_unsupported");
    const fallbackNew = await fallbackStore.get(fallbackCtx, fallbackSecond.memoryIds[0]!);
    const fallbackOldAfter = await fallbackStore.get(fallbackCtx, fallbackFirst.memoryIds[0]!);
    const fallbackLabels = await labelsFor(fallbackStore, fallbackCtx);

    expect(atomicOldAfter!.status).toBe(fallbackOldAfter!.status);
    expect(atomicNew!.content).toBe(fallbackNew!.content);
    expect(atomicNew!.attributes).toEqual(fallbackNew!.attributes);
    expect(atomicNew!.tags).toEqual(fallbackNew!.tags);
    expect(atomicNew!.validFrom).toEqual(fallbackNew!.validFrom);
    expect(atomicNew!.validUntil).toEqual(fallbackNew!.validUntil);
    expect(atomicNew!.claimKey).toEqual(fallbackNew!.claimKey);
    expect([...atomicLabels.entries()].sort()).toEqual([...fallbackLabels.entries()].sort());
  });
});
