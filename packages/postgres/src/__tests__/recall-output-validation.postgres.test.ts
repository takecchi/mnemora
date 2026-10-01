import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider, RecallQuery } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0481: 実 Postgres の `recall()` の出力が、`@mnemora/core` 自身の `RecallResultSchema` を満たす。
 *
 * このパッケージのテストは、すべて `setup-recall-output-contract.ts` が `createRuntime` の `recall` の戻り値を
 * `checkRecallResultContract`（schema・`outputValidation.ok`・TSDoc の約束）に通している。**ただし、検査は
 * テストが `RecallQuery` のその欄を渡したときにだけ走る。**この歯は、これまで実 Postgres のテストが一度も渡して
 * いなかった欄（`digestBandLimit`・`timeWeighting`・`relationMaxCount`・`activityCounting`、`taxonomyGroups`
 * の組み合わせ）を実 Postgres に渡す。runtime は `outputValidation: "throw"` で作る（違反があれば
 * `RecallOutputValidationError` で落ちる）うえ、戻り値の `outputValidation` が `{ ok: true, issues: [] }`
 * であることを各ケースで見る。
 */

const TENANT = "recall-output-validation-pg";
const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};
const embeddingProvider: EmbeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
};

async function setup() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const runtime = createRuntime({
    memoryStore,
    vectorStore,
    outboxStore: new PostgresOutboxStore(db),
    eventStore: new PostgresEventStore(db),
    relationStore: new PostgresRelationStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: throwingLlm,
    embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    outputValidation: "throw",
  });
  return { runtime, memoryStore, vectorStore };
}

async function seed(
  s: Awaited<ReturnType<typeof setup>>,
  ctx: Ctx,
  n: number,
  overrides: (i: number) => Parameters<typeof buildNewMemoryFixture>[0] = () => ({}),
) {
  for (let i = 0; i < n; i += 1) {
    const memory = await s.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        embeddingStatus: "ready",
        content: `記憶 ${i}`,
        digest: `要旨 ${i}`,
        ...overrides(i),
      }),
    );
    await s.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, i * 0.01, 0]);
  }
}

const ctx: Ctx = { tenantId: TENANT };

describe("実 Postgres の recall() の出力は RecallResultSchema を満たす（ADR 0481）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  it("陽性対照: 既定の query は outputValidation が ok で、記憶が返る", async () => {
    const s = await setup();
    await seed(s, ctx, 3);
    const result = await s.runtime.recall(ctx, { vector: [1, 0, 0] });
    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  const SHAPES: ReadonlyArray<readonly [string, RecallQuery]> = [
    ["digestBandLimit: 1（帯を1件に絞る）", { vector: [1, 0, 0], limit: 2, digestBandLimit: 1 }],
    ["digestBandLimit: 3", { vector: [1, 0, 0], limit: 2, digestBandLimit: 3 }],
    [
      "digestBandLimit: 100000（上限を超える大きい値）",
      { vector: [1, 0, 0], digestBandLimit: 100000 },
    ],
    [
      "timeWeighting: eventAwareFreshness",
      { vector: [1, 0, 0], timeWeighting: "eventAwareFreshness" },
    ],
    ["timeWeighting: legacy", { vector: [1, 0, 0], timeWeighting: "legacy" }],
    ["relationMaxCount: 1", { vector: [1, 0, 0], relationMaxCount: 1 }],
    ["activityCounting: subject", { vector: [1, 0, 0], activityCounting: "subject" }],
    ["activityCounting: tenant", { vector: [1, 0, 0], activityCounting: "tenant" }],
    ["association（maxCount: 3）", { vector: [1, 0, 0], limit: 2, association: { maxCount: 3 } }],
    ["association: null（明示 off）", { vector: [1, 0, 0], association: null }],
    ["budget で切り詰める", { vector: [1, 0, 0], budget: { maxMemoryChars: 40 } }],
    ["scopeAggregate: skip", { vector: [1, 0, 0], scopeAggregate: "skip" }],
    [
      "validAt が全記憶の有効期間の外",
      { vector: [1, 0, 0], validAt: new Date("1999-01-01T00:00:00Z") },
    ],
    [
      "includeOutsideValidity: true",
      {
        vector: [1, 0, 0],
        validAt: new Date("1999-01-01T00:00:00Z"),
        includeOutsideValidity: true,
      },
    ],
    ["labels + taxonomyGroups", { vector: [1, 0, 0], labels: ["話題"], taxonomyGroups: true }],
    [
      "overFetchFactor: 0.5（k' が limit を下回る）",
      { vector: [1, 0, 0], limit: 4, overFetchFactor: 0.5 },
    ],
    ["tags（クエリ側の重複を含む）", { vector: [1, 0, 0], tags: ["話題", "話題"] }],
  ];

  it.each(SHAPES)("%s", async (_label, query) => {
    const s = await setup();
    await seed(s, { ...ctx, subjectId: "subj" }, 6, (i) => ({
      subjectId: "subj",
      tags: i % 2 === 0 ? ["話題"] : [],
      occurredAt: i % 3 === 0 ? new Date("2025-12-01T00:00:00Z") : null,
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: i === 5 ? new Date("2025-06-01T00:00:00Z") : null,
    }));
    const result = await s.runtime.recall({ ...ctx, subjectId: "subj" }, query);
    expect(result.outputValidation).toEqual({ ok: true, issues: [] });
  });
});
