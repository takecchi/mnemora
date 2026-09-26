import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * クローン miku の委譲先が書いた回帰テスト。オーナーではない。
 *
 * `packages/testkit` の `InMemory*`（`in-memory-fixtures-negative-limit.test.ts` /
 * `in-memory-fixtures-limit-not-integer.test.ts` / `in-memory-fixtures-getmany-dedupe.test.ts` /
 * `in-memory-fixtures-getvectors-dedupe.test.ts`、PR #804/#806/#811/#812）が既に直した
 * 不一致と**同じ形**の不一致を、`packages/core` 専用の `Fake*`（`runtime-fakes.ts`）に
 * 見つけた。`InMemory*` を直したときの棚卸しが `Fake*` 側には及んでいなかった
 * ——`fake-vector-store-tiebreak.test.ts`（Issue #339）は両方直っているが、負数/非整数
 * limit とダブり id は `Fake*` 側で直っていないまま残っていた。
 *
 * 本物の Postgres 17 + pgvector を手元に立てて実測した（`packages/postgres` の
 * 各 store を直接呼ぶ使い捨てスクリプトで確認、このコミットには含めない）:
 * - `PostgresMemoryStore.getMany([x,x])` は1件（集合演算 `WHERE id = ANY(...)`）。
 * - `PostgresVectorStore.getVectors([x,x,x])` は1件（`memory_id = ANY(...)`）。
 * - `PostgresVectorStore.search` / `PostgresLexicalStore.search` /
 *   `PostgresTrigramLexicalStore.search` / `PostgresEventStore.list` /
 *   `PostgresOutboxStore.claimBatch` / `PostgresMemoryStore.aggregateScope`
 *   （digestBand.limit）は、`limit` が負数・`NaN`・`Infinity`・非整数のとき、
 *   生 SQL の `LIMIT`（bigint パラメータ）が例外を投げる。
 * - `PostgresMemoryStore.purgeExpiredEvents` だけは `limit === -1` の1点が例外にならず
 *   `purged: 0` を返す（`LIMIT opts.limit + 1` の形で組むため）——`limit <= -2` は
 *   他と同じく例外になる。`InMemoryMemoryStore.purgeExpiredEvents` はこの1点を割り切って
 *   「負数はすべて一様に拒む」ため、`-1` ではなく `-2` で確認する
 *   （`in-memory-fixtures-negative-limit.test.ts` と同じ理由）。
 *
 * `FakeMemoryStore`/`FakeVectorStore`/`FakeLexicalStore`/`FakeEventStore`/
 * `FakeOutboxStore` はどれも `packages/testkit` と同じ理由でこの入力を検査しておらず、
 * `Array.prototype.slice` の意味論（負数＝末尾から数えた除外、`NaN`→`0`、`Infinity`→全件、
 * 非整数→切り捨て）を静かに踏んでいた——例外にならず、`limit` が効いていない/
 * 黙って縮む/ほぼ全件返る、という誤った結果になる。
 */

const TENANT = "fake-parity-tenant";
const ctx: Ctx = { tenantId: TENANT };
const SPACE: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };

function fixture(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 720;
  const recordedAt = overrides.recordedAt ?? new Date("2026-01-01T00:00:00.000Z");
  return {
    tenantId: TENANT,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "テスト用の本文",
    contentHash: `fixture-hash-${recordedAt.getTime()}-${Math.random()}`,
    digest: "テスト用の要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.getMany: ids に重複があっても一意な id の集合しか返さない（PR #806/#812 と同じ形）", () => {
  it("同じ id が複数回含まれていても、その id は1回だけ結果に現れる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const x = await memoryStore.createMemory(ctx, fixture());
    const results = await memoryStore.getMany(ctx, [x.id, x.id]);
    expect(results).toHaveLength(1);
  });
});

describe("FakeVectorStore.getVectors: memoryIds に重複があっても一意な id の集合しか返さない（PR #812 と同じ形）", () => {
  it("同じ id が複数回含まれていても、その id は1回だけ結果に現れる", async () => {
    const { memoryStore, vectorStore } = createFakeRuntimeStores();
    const x = await memoryStore.createMemory(ctx, fixture());
    await vectorStore.upsert(ctx, SPACE, x.id, [1, 0, 0]);
    const entries = await vectorStore.getVectors(ctx, SPACE, [x.id, x.id, x.id]);
    expect(entries).toHaveLength(1);
  });
});

describe("Fake*: 負数の limit を渡すと Postgres と同じく例外を投げる（PR #804 と同じ形）", () => {
  it("FakeOutboxStore.claimBatch は limit が負数のとき例外を投げる", async () => {
    const { outboxStore } = createFakeRuntimeStores();
    await expect(
      outboxStore.claimBatch(ctx, {
        limit: -1,
        now: new Date("2026-01-01T00:00:00.000Z"),
        claimedBy: "worker",
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("FakeVectorStore.search は limit が負数のとき例外を投げる", async () => {
    const { vectorStore } = createFakeRuntimeStores();
    await expect(
      vectorStore.search(ctx, SPACE, [0, 0, 0], { limit: -1, filter: { tenantId: TENANT } }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("FakeLexicalStore.search は limit が負数のとき例外を投げる", async () => {
    const { lexicalStore } = createFakeRuntimeStores();
    await expect(
      lexicalStore.search(ctx, "テスト", { limit: -1, filter: { tenantId: TENANT } }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("FakeEventStore.list は filter.limit が負数のとき例外を投げる", async () => {
    const { eventStore } = createFakeRuntimeStores();
    await expect(eventStore.list(ctx, { limit: -1 })).rejects.toThrow(/limit must not be negative/);
  });

  it("FakeMemoryStore.purgeExpiredEvents は limit=-2 のとき例外を投げ、1行も消さない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.purgeExpiredEvents!(ctx, {
        olderThan: new Date("2026-06-01T00:00:00.000Z"),
        limit: -2,
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("FakeMemoryStore.aggregateScope の digestBand: limit が負数のとき例外を投げる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.aggregateScope(ctx, {}, { digestBand: { limit: -1, excludeMemoryIds: [] } }),
    ).rejects.toThrow(/digestBand\.limit must not be negative/);
  });
});

describe("Fake*: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる（PR #811 と同じ形）", () => {
  for (const limit of [NaN, Infinity, 1.5]) {
    it(`FakeOutboxStore.claimBatch は limit=${limit} のとき例外を投げる`, async () => {
      const { outboxStore } = createFakeRuntimeStores();
      await expect(
        outboxStore.claimBatch(ctx, {
          limit,
          now: new Date("2026-01-01T00:00:00.000Z"),
          claimedBy: "worker",
          leaseMs: 60_000,
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`FakeVectorStore.search は limit=${limit} のとき例外を投げる`, async () => {
      const { vectorStore } = createFakeRuntimeStores();
      await expect(
        vectorStore.search(ctx, SPACE, [0, 0, 0], { limit, filter: { tenantId: TENANT } }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`FakeLexicalStore.search は limit=${limit} のとき例外を投げる`, async () => {
      const { lexicalStore } = createFakeRuntimeStores();
      await expect(
        lexicalStore.search(ctx, "テスト", { limit, filter: { tenantId: TENANT } }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`FakeEventStore.list は filter.limit=${limit} のとき例外を投げる`, async () => {
      const { eventStore } = createFakeRuntimeStores();
      await expect(eventStore.list(ctx, { limit })).rejects.toThrow(/limit must be an integer/);
    });

    it(`FakeMemoryStore.purgeExpiredEvents は limit=${limit} のとき例外を投げる`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.purgeExpiredEvents!(ctx, {
          olderThan: new Date("2026-06-01T00:00:00.000Z"),
          limit,
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`FakeMemoryStore.aggregateScope の digestBand: limit=${limit} のとき例外を投げる`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.aggregateScope(ctx, {}, { digestBand: { limit, excludeMemoryIds: [] } }),
      ).rejects.toThrow(/digestBand\.limit must be an integer/);
    });
  }
});

/**
 * miku 了承済み（マネージャー経由）: `FakeTenantSettingsStore` に interface 本番メソッド
 * `setDefaultHalfLifeRecalls`（`?` 付き、ADR 0197）を足し、`packages/postgres`/
 * `packages/testkit` と揃える。値域検査（`assertValidHalfLifeRecalls`）と float4
 * （Postgres の `real` 列）オーバーフロー検査は
 * `in-memory-fixtures-half-life-recalls-float4-overflow.test.ts` と同じ形。
 */
describe("FakeTenantSettingsStore.setDefaultHalfLifeRecalls（ADR 0197、P・T に揃える）", () => {
  it("1e300（float4 の範囲を大きく超える）は例外を投げ、値を書き換えない", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 1e300)).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx)).toBe(720);
  });

  it("3e38（float4 の範囲に収まる）は成功し、その後 getDefaultHalfLifeRecalls で読める", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 3e38);
    expect(await tenantSettingsStore.getDefaultHalfLifeRecalls(ctx)).toBe(3e38);
  });

  it("0以下は assertValidHalfLifeRecalls により例外を投げる", async () => {
    const { tenantSettingsStore } = createFakeRuntimeStores();
    await expect(tenantSettingsStore.setDefaultHalfLifeRecalls!(ctx, 0)).rejects.toThrow();
  });
});

/**
 * `LexicalStore.search` の doc（`packages/core/src/interfaces/lexical-store.ts`、
 * Issue #345 / ADR 0175）は「coverage/rank の両方が完全一致する行の順序も adapter の
 * 責務」と明記し、`PostgresLexicalStore` の `coverage → rank → recorded_at DESC → id`
 * の4段 tie-break を模範として名指ししている。`FakeLexicalStore.search` は coverage/rank
 * の2段止まりで、同点の中身が挿入順（recordedAt 昇順の通常の呼び出し順では逆向き）に
 * 落ちていた——`InMemoryLexicalStore`（`packages/testkit`）と同じ形の不一致。
 * 実測: 本物の Postgres 17 に対し、完全に同じ content を持つ2件（recordedAt だけ違う）を
 * `PostgresLexicalStore.search` に渡すと新しい方が常に先に返る（使い捨てスクリプトで確認）。
 */
describe("FakeLexicalStore.search — coverage/rank が完全一致したときの tie-break（LexicalStore.search doc / ADR 0175）", () => {
  const CONTENT = "同じ内容のテスト用本文";

  it("recordedAt が新しい方を先に返す（PostgresLexicalStore.search と同じ契約）", async () => {
    const { memoryStore, lexicalStore } = createFakeRuntimeStores();
    const older = await memoryStore.createMemory(
      ctx,
      fixture({ content: CONTENT, recordedAt: new Date("2026-01-01T00:00:00.000Z") }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      fixture({ content: CONTENT, recordedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );

    const hits = await lexicalStore.search(ctx, CONTENT, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);
    expect(hits[0]!.memoryId).toBe(newer.id);
    expect(hits[1]!.memoryId).toBe(older.id);
  });
});
