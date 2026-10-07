import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock, Ctx } from "@mnemora/core";
import { createRuntime, DEFAULT_HALF_LIFE_HOURS, defaultDecayStrategy } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 本物の Postgres + `Runtime.recall()` を通して、日をまたいだ減衰を測る。
 * `deps.clock` に可変の `MutableClock`（`examples/chat/src/mutable-clock.ts` と同じ形。別パッケージなのでここに複製する）を注入し、
 * 実時間を待たずに「日をまたいだ」「忘却ゲートの既定余裕を跨いだ」状態を作る。
 */

function createMutableClock(initial: Date): Clock & { set(at: Date): void } {
  let current = initial;
  return {
    now: () => current,
    set: (at: Date) => {
      current = at;
    },
  };
}

async function buildTestRuntime(clock: Clock) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore,
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: new DeterministicLLMProvider(),
    embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
    hashContent: sha256Hex,
    clock,
  });
  return { runtime, memoryStore };
}

describe("runtime.recall() が decay を跨いで実際にどう振る舞うか — 本物の Postgres（Issue #302）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("(甲) observe() した内容は、+24h 後の recall() でも返る（decay_floor_at をまだ跨がない）", async () => {
    await resetTestDatabase();
    const ctx: Ctx = { tenantId: `tenant-decay-next-day-${randomUUID()}` };
    const t0 = new Date();
    const clock = createMutableClock(t0);
    const { runtime } = await buildTestRuntime(clock);

    const text = `昨日言ったこと ${randomUUID()}`;
    const observed = await runtime.observe(ctx, { kind: "utterance", text });
    const memoryId = observed.memoryIds[0]!;

    clock.set(new Date());
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);

    const floorAt = defaultDecayStrategy.floorAt({
      recordedAt: t0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
    });
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(floorAt.getTime()).toBeGreaterThan(t0.getTime() + oneDayMs);

    clock.set(new Date(t0.getTime() + oneDayMs));

    const result = await runtime.recall(ctx, { text, limit: 10 });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(memoryId);

    // 忘却ゲートは既定で有効なまま。+24h ではまだ何も落とさないことを stages 側からも見る（ゲートが働いていないから通ったのではない）。
    const candidateGen = result.explain.stages.find((s) => s.stage === "candidate_generation");
    const detail = candidateGen?.detail as { decayGate?: string } | undefined;
    expect(detail?.decayGate).toBe("pushed_down");
  });

  it("(乙) 忘却ゲートの既定余裕（作成+約129.6日）を跨いだ後は recall() で落ちる（decayGateActive の除外）", async () => {
    await resetTestDatabase();
    const ctx: Ctx = { tenantId: `tenant-decay-gate-${randomUUID()}` };
    const t0 = new Date();
    const clock = createMutableClock(t0);
    const { runtime } = await buildTestRuntime(clock);

    const text = `いずれ忘れられる発話 ${randomUUID()}`;
    const observed = await runtime.observe(ctx, { kind: "utterance", text });
    const memoryId = observed.memoryIds[0]!;

    clock.set(new Date());
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);

    const floorAt = defaultDecayStrategy.floorAt({
      recordedAt: t0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
    });
    // 余裕を跨いだことが揺るがないよう、境界ちょうどではなく +1日を足す。
    const afterFloor = new Date(floorAt.getTime() + 24 * 60 * 60 * 1000);
    clock.set(afterFloor);

    const gated = await runtime.recall(ctx, { text, limit: 10 });
    const gatedIds = gated.memories.map((m) => m.memoryId);
    expect(gatedIds).not.toContain(memoryId);

    const decayedOmissions = gated.omitted.filter(
      (o) => o.kind === "filtered" && o.condition === "decayed",
    );
    expect(decayedOmissions).toHaveLength(1);
    const decayedOmission = decayedOmissions[0] as {
      kind: "filtered";
      condition: "decayed";
      count: number;
      countKind: string;
    };
    // この tenant には `observe()` した1件しか居ない。scope を無視して tenant 全体や DB 全体を数える実装はここで落ちる。
    expect(decayedOmission.count).toBe(1);
    expect(decayedOmission.countKind).toBe("exact");
    const gatedCandidateGen = gated.explain.stages.find((s) => s.stage === "candidate_generation");
    const gatedDetail = gatedCandidateGen?.detail as { decayGate?: string } | undefined;
    expect(gatedDetail?.decayGate).toBe("pushed_down");

    // `includeFullyDecayed: true` でゲートを外しても、既定の scoreThreshold（0.1）のままでは戻ってこない。
    // 段2の再スコアの `decay`/`freshness` は floorAt を過ぎると ≈threshold（0.05）以下になり、ゲートとは別の理由（below_threshold）で落ちる。
    // ゲート単体の効果を切り出すには `scoreThreshold: 0` が要るので、まずそれ自体を検算する。
    const ungatedDefaultThreshold = await runtime.recall(ctx, {
      text,
      limit: 10,
      includeFullyDecayed: true,
    });
    const ungatedDefaultThresholdIds = ungatedDefaultThreshold.memories.map((m) => m.memoryId);
    expect(ungatedDefaultThresholdIds).not.toContain(memoryId);
    expect(ungatedDefaultThreshold.omitted.some((o) => o.kind === "below_threshold")).toBe(true);

    // 対照: `includeFullyDecayed: true` かつ `scoreThreshold: 0` なら戻ってくる。
    // gate 側は `scoreThreshold` を通らない（段1・SQL 側）ので、`scoreThreshold: 0` でも gated 側の結果は変わらないはずで、それも検算する。
    const gatedZeroThreshold = await runtime.recall(ctx, { text, limit: 10, scoreThreshold: 0 });
    const gatedZeroThresholdIds = gatedZeroThreshold.memories.map((m) => m.memoryId);
    expect(gatedZeroThresholdIds).not.toContain(memoryId);

    const ungated = await runtime.recall(ctx, {
      text,
      limit: 10,
      includeFullyDecayed: true,
      scoreThreshold: 0,
    });
    const ungatedIds = ungated.memories.map((m) => m.memoryId);
    expect(ungatedIds).toContain(memoryId);
    const ungatedCandidateGen = ungated.explain.stages.find(
      (s) => s.stage === "candidate_generation",
    );
    const ungatedDetail = ungatedCandidateGen?.detail as { decayGate?: string } | undefined;
    expect(ungatedDetail?.decayGate).toBe("disabled");

    // (c) `includeFullyDecayed: true` のときはこの omission が積まれない。これを固定しないと「常に1件積む」だけの実装でも (a)(b) が通ってしまう。
    expect(ungated.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(
      false,
    );
    expect(
      ungatedDefaultThreshold.omitted.some(
        (o) => o.kind === "filtered" && o.condition === "decayed",
      ),
    ).toBe(false);
  });

  /**
   * 活動時計（`decay_clock: 'activity'` / `'either'`）でも、段1の押し下げと段5の集約が同じ述語を見ていること。
   * 本物の Postgres でしか測れない: `decay_floor_seq` は `bigint` 列で、`count(*) FILTER` の NULL 三値論理も SQL 側の振る舞いである。
   */
  it("(丙) 活動時計のテナントでも、段1の押し下げと段5の集約が同じ述語で一致する（ADR 0165 の2軸）", async () => {
    await resetTestDatabase();
    const ctx: Ctx = { tenantId: `tenant-decay-activity-${randomUUID()}` };
    const now = new Date();
    const clock = createMutableClock(now);
    const { runtime, memoryStore } = await buildTestRuntime(clock);
    const { db } = await getTestClient();
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);

    // 壁時計では絶対に沈まない（+100年）。活動時計の軸だけで判定されなければならない。
    const farFuture = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365 * 100);
    // 壁時計では既に沈んでいる。'activity' では**無視**されなければならない。
    const farPast = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 365);

    const seed = async (overrides: {
      decayFloorAt: Date;
      decayFloorSeq: number | null;
      hash: string;
    }) =>
      memoryStore.createMemory(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        sourceObservationId: null,
        extractorVersion: null,
        content: `活動時計の歯 ${overrides.hash}`,
        contentHash: `${ctx.tenantId}-${overrides.hash}`,
        digest: overrides.hash,
        digestSource: "llm",
        provenance: { kind: "imported", batchId: "activity-clock-fixture" },
        tags: [],
        occurredAt: null,
        recordedAt: now,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
        decayFloorAt: overrides.decayFloorAt,
        decayBaseSeq: 0,
        decayFloorSeq: overrides.decayFloorSeq,
        embeddingStatus: "skipped",
      });

    // activity_seq はこのテナントではまだ1本も進んでいない（nowSeq = 0）。
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);

    // 壁=生 / 活=死（0 > 0 は false）: 'activity' でも 'either' でも……
    await seed({ decayFloorAt: farFuture, decayFloorSeq: 0, hash: "wall-alive-activity-dead" });
    // 壁=死 / 活=生
    await seed({ decayFloorAt: farPast, decayFloorSeq: 100, hash: "wall-dead-activity-alive" });
    // 壁=死 / 活=死
    await seed({ decayFloorAt: farPast, decayFloorSeq: 0, hash: "wall-dead-activity-dead" });
    // 壁=死 / 活は床が無い（NULL）: この軸では沈まない。
    await seed({ decayFloorAt: farPast, decayFloorSeq: null, hash: "wall-dead-activity-null" });

    const decayedCount = async (): Promise<number> => {
      // ⚠ `text` を渡すと埋め込みが要る。ここで見たいのは段5の集約なので、
      //   ベクトルを直接渡して段1を走らせる（上の4件は embeddingStatus: 'skipped' で
      //   ベクトルを持たないため、`memories` には1件も返らない——それでよい）。
      const result = await runtime.recall(ctx, { vector: [0, 0, 1], limit: 10 });
      const omission = result.omitted.find(
        (o) => o.kind === "filtered" && o.condition === "decayed",
      ) as { count: number; countKind: string } | undefined;
      if (omission === undefined) return 0;
      expect(omission.countKind).toBe("exact");
      return omission.count;
    };

    expect(await decayedCount()).toBe(3);

    // 'activity': 活動時計だけを見るので、壁時計の farPast は一切効かない。
    // ⚠ `decay_clock != 'wall'` のテナントでは recall のたびに activity_seq が +1 する。`decayFloorSeq: 100` はそれでも当分沈まない。
    await tenantSettingsStore.setDecayClock(ctx, "activity");
    expect(await decayedCount()).toBe(2);

    // 'either': **OR**（どちらかが生きていれば沈まない）⟹ 両方沈んだ1件だけ。
    // ⚠ AND/OR を取り違えた集約（`NOT wall OR NOT seq`）はここで 3 を返して赤くなる。
    await tenantSettingsStore.setDecayClock(ctx, "either");
    expect(await decayedCount()).toBe(1);

    const ungated = await runtime.recall(ctx, {
      vector: [0, 0, 1],
      limit: 10,
      includeFullyDecayed: true,
    });
    expect(ungated.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(
      false,
    );
  });
});
