import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_HALF_LIFE_HOURS } from "@mnemora/core";
import {
  createTimeWeightingBenchRuntime,
  seedTimeWeightingMemories,
  runTimeWeightingCase,
  aggregateTimeWeightingResults,
} from "../time-weighting-bench.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "../time-weighting-case-set.dev.js";
import { daysBefore, hoursBefore } from "../time-weighting-dates.js";
import { assertAffinityMeasured } from "../recalled-score.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 配線の検査であって、回答品質の測定ではない。
// DeterministicEmbeddingProvider のコサイン類似度は常に0以上。1件目が scoreThreshold を下げて score.freshness を直接読むのは、意味を持たない擬似物の affinity に依存しないため。
describe("examples/chat: answer-time-weighting（本物の Postgres、配線検査）", () => {
  it("occurredAt の無い記憶: legacy は freshness を記録時刻の古さで沈め、eventAwareFreshness は1に固定する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createTimeWeightingBenchRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.llmMode).toBe("deterministic");
      const recallAt = new Date("2026-06-01T09:00:00.000Z");
      const ctx = { tenantId: "time-weighting-freshness-wiring" };

      await seedTimeWeightingMemories(handle.memoryStore, handle.runtime, handle.clock, ctx, [
        {
          localId: "long-held-fact",
          content: "この人は打ち合わせの飲み物はいつも紅茶を選ぶ。",
          recordedAt: daysBefore(recallAt, 400),
          reinforceAt: [daysBefore(recallAt, 1)],
        },
      ]);
      handle.clock.set(recallAt);

      const legacy = await handle.runtime.recall(ctx, {
        text: "打ち合わせの飲み物は何がいいですか?",
        timeWeighting: "legacy",
        scoreThreshold: -1000,
      });
      const eventAware = await handle.runtime.recall(ctx, {
        text: "打ち合わせの飲み物は何がいいですか?",
        timeWeighting: "eventAwareFreshness",
        scoreThreshold: -1000,
      });

      expect(legacy.memories).toHaveLength(1);
      expect(eventAware.memories).toHaveLength(1);

      const legacyFreshness = legacy.memories[0]!.score.freshness;
      const eventAwareFreshness = eventAware.memories[0]!.score.freshness;

      expect(legacyFreshness).toBeLessThan(0.01);
      expect(eventAwareFreshness).toBe(1);
      expect(eventAwareFreshness).toBeGreaterThan(legacyFreshness);
    } finally {
      await handle.close();
    }
  });

  it("occurredAt が在る記憶: legacy と eventAwareFreshness で freshness が1文字も変わらない（ADR 0300 §2 の不変条件）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createTimeWeightingBenchRuntime(requireDatabaseUrl(), {});
    try {
      const recallAt = new Date("2026-06-01T09:00:00.000Z");
      const ctx = { tenantId: "time-weighting-event-aware-invariance" };

      await seedTimeWeightingMemories(handle.memoryStore, handle.runtime, handle.clock, ctx, [
        {
          localId: "old-event",
          content: "1年ほど前にiPhoneからXperiaへ機種変更した。",
          occurredAt: daysBefore(recallAt, 400),
          recordedAt: hoursBefore(recallAt, 1),
          reinforceAt: [hoursBefore(recallAt, 1)],
        },
      ]);
      handle.clock.set(recallAt);

      const legacy = await handle.runtime.recall(ctx, {
        text: "いま使っているスマホの機種は何ですか?",
        timeWeighting: "legacy",
        scoreThreshold: -1000,
      });
      const eventAware = await handle.runtime.recall(ctx, {
        text: "いま使っているスマホの機種は何ですか?",
        timeWeighting: "eventAwareFreshness",
        scoreThreshold: -1000,
      });

      expect(legacy.memories).toHaveLength(1);
      expect(eventAware.memories).toHaveLength(1);
      const legacyScore = legacy.memories[0]!.score;
      const eventAwareScore = eventAware.memories[0]!.score;
      assertAffinityMeasured(legacyScore);
      assertAffinityMeasured(eventAwareScore);
      expect(eventAwareScore.freshness).toBe(legacyScore.freshness);
      expect(eventAwareScore.total).toBe(legacyScore.total);
    } finally {
      await handle.close();
    }
  });

  it("期限切れの予定は timeWeighting に関係なく候補から除かれる（validAt ゲートは方針を参照しない）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createTimeWeightingBenchRuntime(requireDatabaseUrl(), {});
    try {
      const recallAt = new Date("2026-06-01T09:00:00.000Z");
      const ctx = { tenantId: "time-weighting-valid-at-invariance" };

      await seedTimeWeightingMemories(handle.memoryStore, handle.runtime, handle.clock, ctx, [
        {
          localId: "expired-schedule",
          content: "定例会議は水曜日16時から。",
          recordedAt: daysBefore(recallAt, 60),
          validFrom: daysBefore(recallAt, 60),
          validUntil: daysBefore(recallAt, 1),
          reinforceAt: [daysBefore(recallAt, 30)],
        },
      ]);
      handle.clock.set(recallAt);

      for (const policy of ["legacy", "eventAwareFreshness"] as const) {
        const recall = await handle.runtime.recall(ctx, {
          text: "定例会議は何曜日からですか?",
          timeWeighting: policy,
          scoreThreshold: -1000,
        });
        expect(recall.memories).toHaveLength(0);
        const expiredOmission = recall.omitted.find(
          (o) => o.kind === "filtered" && o.condition === "expired",
        );
        expect(expiredOmission).toBeDefined();
      }
    } finally {
      await handle.close();
    }
  });

  it("runTimeWeightingCase: dev類型Aの1ケースを実行し、gradeAnswer/集計まで通る（deterministic なので正誤の向きは主張しない）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createTimeWeightingBenchRuntime(requireDatabaseUrl(), {});
    try {
      const caseA = TIME_WEIGHTING_CASE_SET_DEV.find(
        (c) => c.kind === "reinforced-fact-vs-fresh-weak",
      );
      expect(caseA).toBeDefined();
      const result = await runTimeWeightingCase(handle, caseA!, "time-weighting-case-wiring", 1);

      expect(result.byPolicy.legacy).toBeDefined();
      expect(result.byPolicy.eventAwareFreshness).toBeDefined();
      expect(result.byPolicy.legacy.answer).toBe(result.byPolicy.legacy.prompt);
      expect(result.byPolicy.eventAwareFreshness.answer).toBe(
        result.byPolicy.eventAwareFreshness.prompt,
      );

      const aggregate = aggregateTimeWeightingResults([result]);
      expect(aggregate).toHaveLength(2);
      for (const cell of aggregate) {
        expect(cell.trials).toBe(1);
        expect(cell.caseId).toBe(caseA!.id);
      }
    } finally {
      await handle.close();
    }
  });

  it("DEFAULT_HALF_LIFE_HOURS はこのベンチの設計が前提にしている値のまま（720）——動いたらケースの日数を作り直す必要がある", () => {
    // この値は main が動けば変わりうる。固定しているのはこのケース集合が前提にした値で、動いたらケースの日数を設計し直す合図にする。
    expect(DEFAULT_HALF_LIFE_HOURS).toBe(720);
  });
});

afterAll(async () => {
  await closeTestClient();
});
