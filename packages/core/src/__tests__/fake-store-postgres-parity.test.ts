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

/**
 * `packages/testkit` の `InMemoryMemoryStore.archiveDecayed`（Issue #880、
 * `in-memory-fixtures-archive-decayed-limit.test.ts`）と同じ形の不一致を
 * `FakeMemoryStore.archiveDecayed` にも見つけた——どちらも `.slice(0, Math.max(0,
 * opts.limit))` を検査せず使っており、`PostgresMemoryStore.archiveDecayed` が
 * `LIMIT`（bigint パラメータ）へそのまま渡して例外にする入力（負数・`NaN`・
 * `Infinity`・非整数）を、書き込みの副作用（`status` を `archived` にし、イベントを
 * 積む）付きで静かに通してしまっていた。実測は `in-memory-fixtures-archive-decayed-limit.test.ts`
 * のコメント参照。
 */
describe("FakeMemoryStore.archiveDecayed: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も archived にしない（Issue #880）", () => {
  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    it(`limit=${limit} は例外を投げ、対象の Memory を archived にしない`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const memory = await memoryStore.createMemory(ctx, fixture());
      await expect(
        memoryStore.archiveDecayed(ctx, { now: new Date("2026-06-01T00:00:00.000Z"), limit }),
      ).rejects.toThrow(/limit must (be an integer|not be negative)/);
      const after = await memoryStore.get(ctx, memory.id);
      expect(after?.status).toBe("active");
    });
  }
});

/**
 * `packages/testkit` の `InMemoryMemoryStore.reinforce`/`createMemory`/`InMemoryEventStore.append`
 * （Issue #807、`in-memory-fixtures-invalid-date.test.ts`）と同じ形の不一致を
 * `FakeMemoryStore`/`FakeEventStore` にも見つけた。実測（Postgres が Invalid Date を
 * `timestamptz` 列で拒む根拠）は `in-memory-fixtures-invalid-date.test.ts` のコメント参照
 * ——ここでは同じ判定を `packages/core` 専用の Fake に対して確かめる。
 */
describe("FakeMemoryStore.reinforce: Invalid Date を渡すと Postgres と同じく例外を投げ、状態を書き換えない（Issue #807）", () => {
  it("Invalid Date は例外を投げ、lastReinforcedAt/decayFloorAt を変えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture());
    await expect(memoryStore.reinforce(ctx, memory.id, new Date(Number.NaN))).rejects.toThrow(
      /at must be a valid Date/,
    );
    const after = await memoryStore.get(ctx, memory.id);
    expect(after?.lastReinforcedAt).toBeNull();
    expect(after?.decayFloorAt).toEqual(memory.decayFloorAt);
  });
});

describe("FakeMemoryStore.createMemory: Date フィールドに Invalid Date を渡すと例外を投げ、Memory を作らない（Issue #807）", () => {
  for (const field of ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const) {
    it(`${field}=Invalid Date は例外を投げる`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.createMemory(ctx, fixture({ [field]: new Date(Number.NaN) } as never)),
      ).rejects.toThrow(/must be a valid Date/);
    });
  }
});

describe("FakeEventStore.append: at に Invalid Date を渡すと例外を投げ、イベントを積まない（Issue #807）", () => {
  it("Invalid Date は例外を投げ、events に積まれない", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture());
    await expect(
      eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "updated",
        at: new Date(Number.NaN),
        actor: { type: "system" },
        meta: {},
      }),
    ).rejects.toThrow(/at must be a valid Date/);
    const list = await eventStore.list(ctx, {});
    expect(list).toHaveLength(0);
  });
});

/**
 * `packages/testkit` の `InMemoryMemoryStore.createMemory`（Issue #817、PR #815 と同根、
 * `in-memory-fixtures-half-life-hours-float4-overflow.test.ts`）と同じ形の不一致を
 * `FakeMemoryStore` にも見つけた。⚠ `strength` には足さない——理由（`isStrengthInRange`
 * の時点で `1e300` は既に値域外として拒まれ、float4 オーバーフローに到達しない）は
 * `in-memory-fixtures-half-life-hours-float4-overflow.test.ts` のコメント、および
 * `runtime-fakes.ts` の `createMemoryIdempotent` doc コメント（ADR 0125「引き受ける負債」
 * ——`halfLifeHours` の値域全体の検査はこの Fake に意図して無い）参照。
 */
describe("FakeMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む（Issue #817）", () => {
  it("1e300（float4 の範囲を大きく超える）は例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, fixture({ halfLifeHours: 1e300 }))).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it("halfLifeHours: 0（既存の recall-pipeline.test.ts が使う『壊れた』Memory）は引き続き成功する（回帰確認）", async () => {
    // `createMemoryIdempotent` の doc コメント（ADR 0125「引き受ける負債」）が明記する
    // とおり、この Fake は `halfLifeHours` の値域全体を検査しない——float4 オーバーフロー
    // だけを見る狭い検査を追加しても、`0` のような既存の「壊れた」入力は通り続ける
    // ことをここで確かめる（通らなくなると `recall-pipeline.test.ts` の複数の歯が
    // 構造的に書けなくなる）。
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, fixture({ halfLifeHours: 0 }));
    expect(memory.halfLifeHours).toBe(0);
  });

  it("strength=1e300 は（別の理由=値域外で）引き続き例外を投げる（回帰確認、float4 検査は不要）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, fixture({ strength: 1e300 }))).rejects.toThrow(
      /strength out of range/,
    );
  });
});

/**
 * `packages/testkit` の `InMemoryMemoryStore.createMemory`（Issue #816、NUL 側のみ、
 * `in-memory-fixtures-nul-content.test.ts`）と同じ形の不一致を `FakeMemoryStore` にも
 * 見つけた。範囲の切り方（`content` だけに絞る理由）は
 * `in-memory-fixtures-nul-content.test.ts` のコメント参照——`packages/testkit` と同じ
 * 範囲に揃える。
 */
describe("FakeMemoryStore.createMemory: content に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816、NUL 側のみ）", () => {
  it("content の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ content: "abc\u0000def" })),
    ).rejects.toThrow(/must not contain NUL/);
  });
});
