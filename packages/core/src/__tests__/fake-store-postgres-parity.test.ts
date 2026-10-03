import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
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
 * `packages/testkit` の `in-memory-fixtures-limit-bigint-range.test.ts` と同じ判定を、
 * `packages/core` 専用の Fake に当てる。bigint に収まらない整数（2^63 以上）は
 * `Number.isInteger` を通るため、上の2つの describe の検査をすり抜けていた。Postgres は
 * `2 ** 63` を `out of range for type bigint`、`1e21` を `invalid input syntax for type
 * bigint` で拒む（実測は testkit 側のテストのコメント参照）。
 */
describe("Fake*: bigint に収まらない limit（2^63 以上）を渡すと Postgres と同じく例外を投げる", () => {
  const calls: [name: string, call: (limit: number) => Promise<unknown>][] = [
    [
      "FakeOutboxStore.claimBatch",
      (limit) =>
        createFakeRuntimeStores().outboxStore.claimBatch(ctx, {
          limit,
          now: new Date("2026-01-01T00:00:00.000Z"),
          claimedBy: "worker",
          leaseMs: 60_000,
        }),
    ],
    [
      "FakeVectorStore.search",
      (limit) =>
        createFakeRuntimeStores().vectorStore.search(ctx, SPACE, [0, 0, 0], {
          limit,
          filter: { tenantId: TENANT },
        }),
    ],
    [
      "FakeLexicalStore.search",
      (limit) =>
        createFakeRuntimeStores().lexicalStore.search(ctx, "テスト", {
          limit,
          filter: { tenantId: TENANT },
        }),
    ],
    ["FakeEventStore.list", (limit) => createFakeRuntimeStores().eventStore.list(ctx, { limit })],
    [
      "FakeMemoryStore.purgeExpiredEvents",
      (limit) =>
        createFakeRuntimeStores().memoryStore.purgeExpiredEvents!(ctx, {
          olderThan: new Date("2026-06-01T00:00:00.000Z"),
          limit,
        }),
    ],
    [
      "FakeMemoryStore.aggregateScope（digestBand.limit）",
      (limit) =>
        createFakeRuntimeStores().memoryStore.aggregateScope(
          ctx,
          {},
          { digestBand: { limit, excludeMemoryIds: [] } },
        ),
    ],
    [
      "FakeMemoryStore.archiveDecayed",
      (limit) =>
        createFakeRuntimeStores().memoryStore.archiveDecayed(ctx, {
          now: new Date("2026-06-01T00:00:00.000Z"),
          limit,
        }),
    ],
  ];
  for (const [name, call] of calls) {
    for (const limit of [2 ** 63, 1e21]) {
      it(`${name} は limit=${limit} のとき例外を投げる`, async () => {
        await expect(call(limit)).rejects.toThrow(/limit must fit in a Postgres bigint/);
      });
    }
    it(`${name} は limit=2^63-1024（2^63 未満で最大の double）では例外を投げない（回帰確認）`, async () => {
      await expect(call(2 ** 63 - 1024)).resolves.toBeDefined();
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
  // Issue #951（2026-09-26）: 以前はここで非 ASCII だけの content/query（日本語）を
  // 使っていたが、`FakeLexicalStore.search` を PostgresLexicalStore に揃えた結果、
  // 非 ASCII だけのクエリは（本物の Postgres と同じく）常に0件を返すようになった
  // （`mnemora_lexical_query_terms` がクエリ側の非 ASCII を落とすため）。この歯が
  // 見たいのは tie-break（coverage/rank が同値のときの順序）であって非 ASCII の
  // 扱いではないため、ASCII の content に差し替える
  // （`packages/postgres/src/__tests__/lexical-search-tiebreak.test.ts` の
  // `TIED_CONTENT` と同じ文字列——postgres 側の同種の歯と揃えてある）。
  const CONTENT = "widget alpha bravo tie-break test content";

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
 * `packages/testkit` の `InMemoryOutboxStore.claimBatch`
 * （`in-memory-fixtures-claim-batch-lease-ms.test.ts`）と同じ形の不一致が `FakeOutboxStore.claimBatch`
 * にもあった。`PostgresOutboxStore.claimBatch` は `now` と `new Date(now - leaseMs)` を
 * `timestamptz` のパラメータとして送るため、どちらかが Invalid Date になる入力では例外になる
 * （実測は testkit 側のテストのコメント参照）。修正前の Fake は `leaseMs` が `NaN` /
 * `±Infinity` / `1e20` でも、未 claim のジョブを claim していた。
 */
describe("FakeOutboxStore.claimBatch: リースの境界時刻が Date にならない入力は、Postgres と同じく例外を投げ、1件も claim しない", () => {
  const cases: [label: string, now: Date, leaseMs: number][] = [
    ["leaseMs=NaN", new Date("2100-01-01T00:00:00.000Z"), Number.NaN],
    ["leaseMs=Infinity", new Date("2100-01-01T00:00:00.000Z"), Number.POSITIVE_INFINITY],
    ["leaseMs=-Infinity", new Date("2100-01-01T00:00:00.000Z"), Number.NEGATIVE_INFINITY],
    ["leaseMs=1e20", new Date("2100-01-01T00:00:00.000Z"), 1e20],
    ["now=Invalid Date", new Date(Number.NaN), 60_000],
  ];
  for (const [label, now, leaseMs] of cases) {
    it(`${label} は例外を投げ、ジョブを claim しない`, async () => {
      const { memoryStore, outboxStore } = createFakeRuntimeStores();
      await memoryStore.createMemory(ctx, fixture({ embeddingStatus: "failed" }));
      await memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 1 });
      await expect(
        outboxStore.claimBatch(ctx, {
          kinds: ["embed"],
          limit: 5,
          now,
          claimedBy: "test",
          leaseMs,
        }),
      ).rejects.toThrow(/claimBatch: now - leaseMs must be a valid Date/);
      const jobs = await outboxStore.claimBatch(ctx, {
        kinds: ["embed"],
        limit: 5,
        now: new Date("2100-01-01T00:00:00.000Z"),
        claimedBy: "test",
        leaseMs: 60_000,
      });
      expect(jobs.map((j) => j.attempts)).toEqual([1]);
    });
  }
});

/**
 * `packages/testkit` の `InMemoryMemoryStore.requeueEmbedJobs`
 * （`in-memory-fixtures-requeue-embed-jobs-limit.test.ts`）と同じ形の不一致が
 * `FakeMemoryStore.requeueEmbedJobs` にもあった——`.slice(0, Math.max(0, opts.limit))` を
 * 検査せず使っており（Issue #880 で `archiveDecayed` から取り除いた形）、
 * `PostgresMemoryStore.requeueEmbedJobs` が `LIMIT`（bigint パラメータ）へそのまま渡して
 * 例外にする入力（負数・`NaN`・`Infinity`・非整数）を、書き込みの副作用
 * （`embeddingStatus` を `pending` に戻し、embed ジョブを積む）付きで通していた。
 */
describe("FakeMemoryStore.requeueEmbedJobs: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も積み直さない", () => {
  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 63, 1e21]) {
    it(`limit=${limit} は例外を投げ、embeddingStatus も outbox も変えない`, async () => {
      const { memoryStore, outboxStore } = createFakeRuntimeStores();
      const memory = await memoryStore.createMemory(ctx, fixture({ embeddingStatus: "failed" }));
      await expect(
        memoryStore.requeueEmbedJobs(ctx, { statuses: ["failed"], limit }),
      ).rejects.toThrow(/limit must (be an integer|not be negative|fit in a Postgres bigint)/);
      expect((await memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("failed");
      const jobs = await outboxStore.claimBatch(ctx, {
        kinds: ["embed"],
        limit: 100,
        now: new Date("2100-01-01T00:00:00.000Z"),
        claimedBy: "test",
        leaseMs: 1,
      });
      expect(jobs).toEqual([]);
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
 * 上の #817 の検査は float4 の**上側**（`Infinity` へ丸まる）だけを見ていた。Postgres の
 * `real` は、0 でない値が float4 で 0 に丸まる（アンダーフロー）ときも拒む——
 * `packages/testkit` の `in-memory-fixtures-float4-underflow.test.ts` と同じ形で揃える。
 * `halfLifeHours: 0` そのもの（下の回帰確認）は「0 に丸まった」のではないので、引き続き通す。
 */
describe("FakeMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む", () => {
  it("halfLifeHours: 1e-300 は例外を投げる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, fixture({ halfLifeHours: 1e-300 }))).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it("strength: 1e-46 は例外を投げる（値域 (0, 1] の中でも float4 では 0 になる）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, fixture({ strength: 1e-46 }))).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it("1e-45（float4 の非正規数に収まる）と halfLifeHours: 0 は引き続き成功する（回帰確認）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const a = await memoryStore.createMemory(ctx, fixture({ strength: 1e-45 }));
    const b = await memoryStore.createMemory(ctx, fixture({ halfLifeHours: 0 }));
    expect([a.strength, b.halfLifeHours]).toEqual([1e-45, 0]);
  });
});

/**
 * `packages/testkit` の `InMemoryMemoryStore.createMemory`（Issue #816、
 * `in-memory-fixtures-nul-content.test.ts`）と同じ形の不一致を `FakeMemoryStore` にも
 * 見つけた。範囲の切り方（`content`・`subjectId`・`tags`・`digest` を塞ぎ、`tenantId`
 * は対象外とする理由）は `in-memory-fixtures-nul-content.test.ts` のコメント参照
 * ——`packages/testkit` と同じ範囲に揃える。
 */
describe("FakeMemoryStore.createMemory: content に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816）", () => {
  it("content の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ content: "abc\u0000def" })),
    ).rejects.toThrow(/must not contain NUL/);
  });
});

describe("FakeMemoryStore.createMemory: subjectId に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("subjectId の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ subjectId: "abc\u0000def" })),
    ).rejects.toThrow(/input\.subjectId contains a NUL character/); // ADR 0563: 識別子の NUL は MalformedIdentifierError（InMemory・Postgres と同じ）
  });
});

describe("FakeMemoryStore.createMemory: tags の要素に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("tags[0] の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ tags: ["ok-tag", "abc\u0000def"] })),
    ).rejects.toThrow(/tags must not contain NUL/);
  });
});

describe("FakeMemoryStore.createMemory: digest に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("digest の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ digest: "abc\u0000def" })),
    ).rejects.toThrow(/digest must not contain NUL/);
  });
});

/**
 * `packages/testkit` の `in-memory-fixtures-observation-nul.test.ts` と同じ判定を、
 * `packages/core` 専用の Fake に当てる（Issue #816 の NUL 側の残り）。Postgres は
 * Observation の `text` 列（`subjectId`・`externalId`・`kind`）と `jsonb` 列（`payload`・
 * `attributes`）、`createMemory` の `jsonb` 列（`attributes`・`provenance`）の NUL を拒む
 * （実測は testkit 側のテストのコメント参照）。
 */
describe("FakeMemoryStore: Observation の口と createMemory の jsonb 列は、NUL を含む値を Postgres と同じく拒む", () => {
  const observation = (overrides: Partial<NewObservation>): NewObservation => ({
    tenantId: TENANT,
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "こんにちは" },
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    attributes: {},
    ...overrides,
  });
  const cases: [label: string, overrides: Partial<NewObservation>][] = [
    ["subjectId", { subjectId: "subject\u0000" }],
    ["externalId", { externalId: "ext\u0000" }],
    ["kind", { kind: "utterance\u0000" }],
    ["payload の値", { payload: { text: "a\u0000b" } }],
    ["payload のキー", { payload: { "te\u0000xt": "a" } }],
    ["payload の入れ子", { payload: { name: "n", data: { deep: ["ok", { v: "a\u0000" }] } } }],
    ["attributes の値", { attributes: { k: "a\u0000b" } }],
  ];
  for (const [label, overrides] of cases) {
    it(`createObservationWithOutbox: ${label} に NUL → 例外、extract ジョブを積まない`, async () => {
      const { memoryStore, outboxStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.createObservationWithOutbox(ctx, observation(overrides), ["extract"]),
      ).rejects.toThrow(
        // ADR 0563: `subjectId`・`externalId` の NUL は MalformedIdentifierError（"input.subjectId contains a NUL character …"）。
        // それ以外の欄は素の Error（"… must not contain NUL characters"）。
        /must not contain NUL characters|^input\.(subjectId|externalId) contains a NUL character/,
      );
      const jobs = await outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date("2100-01-01T00:00:00.000Z"),
        claimedBy: "test",
        leaseMs: 1,
      });
      expect(jobs).toEqual([]);
    });
  }

  it("NUL でない値（結合文字・ZWJ・RTL・異体字セレクタ・文字どおりの \\u0000）は受け入れる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const text = "é 👨‍👩‍👧 שלום 葛\u{E0100} \\u0000";
    const created = await memoryStore.createObservation(
      ctx,
      observation({ payload: { text }, attributes: { k: text } }),
    );
    expect((await memoryStore.getObservation(ctx, created.id))?.payload).toEqual({ text });
  });

  it("createMemory: attributes / provenance に NUL → 例外", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemory(ctx, fixture({ attributes: { k: "a\u0000" } })),
    ).rejects.toThrow(/attributes must not contain NUL characters/);
    await expect(
      memoryStore.createMemory(
        ctx,
        fixture({ contentHash: "h-prov", provenance: { kind: "imported", batchId: "b\u0000" } }),
      ),
    ).rejects.toThrow(/provenance must not contain NUL characters/);
  });
});
