import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

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

describe("FakeLexicalStore.search — coverage/rank が完全一致したときの tie-break（LexicalStore.search doc / ADR 0175）", () => {
  // tie-break（coverage/rank が同値のときの順序）を見るので、ASCII の content を使う: 非 ASCII だけの content/query は Postgres と同じく常に0件になる。
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

/** 負数だけは Postgres も常には例外にならない（テナントの行が無く統計が古いと、CTE の中の `Limit` が評価されず空で返る）が、この Fake は常に断る。 */
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

/** 負数だけは Postgres も常には例外にならない（テナントの行が無く統計が古いと、CTE の中の `Limit` が評価されず空で返る）が、この Fake は常に断る。 */
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

/** `strength` には足さない: `isStrengthInRange` の時点で `1e300` は既に値域外として拒まれ、float4 オーバーフローに到達しない。 */
describe("FakeMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む（Issue #817）", () => {
  it("1e300（float4 の範囲を大きく超える）は例外を投げ、Memory を作らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createMemory(ctx, fixture({ halfLifeHours: 1e300 }))).rejects.toThrow(
      /does not fit in a Postgres "real"/,
    );
  });

  it("halfLifeHours: 0（既存の recall-pipeline.test.ts が使う『壊れた』Memory）は引き続き成功する（回帰確認）", async () => {
    // この Fake は `halfLifeHours` の値域全体を検査しない: 狭い検査を足しても、`0` のような既存の「壊れた」入力は通り続ける。
    // 通らなくなると `recall-pipeline.test.ts` の複数の歯が構造的に書けなくなる。
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

/** `halfLifeHours: 0` そのもの（下の回帰確認）は「0 に丸まった」のではないので、引き続き通す。 */
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

  // float4 の最小の非正規数は約 1.4013e-45。その半分（約 7.0065e-46）より小さい値は 0 に丸まり、大きい値は最小の非正規数に丸まる。境界の両側を見る。
  it("境界の両側: 7.0e-46（0 に丸まる）は拒み、7.1e-46（最小の非正規数に丸まる）は通す", async () => {
    expect(Math.fround(7.0e-46)).toBe(0);
    expect(Math.fround(7.1e-46)).toBe(1.4012984643248171e-45);
    for (const field of ["halfLifeHours", "strength"] as const) {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(
        memoryStore.createMemory(
          ctx,
          fixture({ contentHash: `edge-low-${field}`, [field]: 7.0e-46 }),
        ),
      ).rejects.toThrow(/does not fit in a Postgres "real"/);
      await expect(
        memoryStore.createMemory(
          ctx,
          fixture({ contentHash: `edge-high-${field}`, [field]: 7.1e-46 }),
        ),
      ).resolves.toBeDefined();
    }
  });

  it("createMemoryWithOutbox も同じ入口で拒む（strength: 1e-46、#1095）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createMemoryWithOutbox(ctx, fixture({ strength: 1e-46 }), []),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });
});

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
        // `subjectId`・`externalId` の NUL は MalformedIdentifierError、それ以外の欄は素の Error。
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

  // jsonb の判定は `JSON.stringify` した結果を辿る（Postgres が受け取る形）ので、`toJSON` による変換も同じ形になる。
  it("toJSON が NUL を返す値は拒む（元の値には NUL が無くても、Postgres が受け取る JSON に NUL がある）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.createObservation(
        ctx,
        observation({ payload: { toJSON: () => ({ text: "a\u0000b" }) } as never }),
      ),
    ).rejects.toThrow(/payload must not contain NUL characters/);
    await expect(
      memoryStore.createObservation(
        ctx,
        observation({ attributes: { toJSON: () => ({ k: "a\u0000" }) } as never }),
      ),
    ).rejects.toThrow(/attributes must not contain NUL characters/);
  });

  it("元の値に NUL があっても、toJSON が消すなら通す（Postgres が受け取る JSON に NUL が無い）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    // 数えられない（列挙されない）プロパティにする——Fake の複製（structuredClone）が関数を持つ欄で落ちないように。
    const payload = Object.defineProperty({ text: "a\u0000b" }, "toJSON", {
      value: () => ({ text: "ok" }),
      enumerable: false,
    });
    await expect(
      memoryStore.createObservation(ctx, observation({ payload: payload as never })),
    ).resolves.toBeDefined();
  });

  it("同じ externalId の Observation が既に在っても、NUL を含む再送は例外になる（#1073）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createObservation(ctx, observation({ externalId: "ext-1" }));
    await expect(
      memoryStore.createObservation(
        ctx,
        observation({ externalId: "ext-1", payload: { text: "\u0000" } }),
      ),
    ).rejects.toThrow(/must not contain NUL characters/);
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
