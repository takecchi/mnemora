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
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `answer-time-weighting` ベンチの配線検査（本物の Postgres、鍵不要、決定的。Issue #690 / PR #697）。
 *
 * 🔴 **これは配線の検査であって、回答品質の測定ではない**（`answer-bench.postgres.test.ts`
 * と同じ規律）。provider は `env: {}`（`OPENAI_API_KEY` 無し）で `deterministic` を強制する。
 *
 * ⚠ **`DeterministicEmbeddingProvider` の性質を1つ使っている**（`packages/testkit` の
 * `vectorFor` docstring・実装参照）: 文字コードの和を `997` で mod するため、すべての
 * 成分は非負——⟹ どんな2つのテキストのコサイン類似度も常に **0以上**になる
 * （負の類似度にはならない）。これにより `ScoreBreakdown.total` の符号は
 * `decay × tagMatch × freshness × strength`（すべて非負）の符号だけで決まり、
 * `affinity`（similarity）の大小に関係なく **legacy が freshness を極小にする効果を
 * 打ち消せない**——1件目のテストが `scoreThreshold` を大きく下げて `score.freshness` を
 * 直接読むのは、`affinity` の実際の値（意味を持たない擬似物なので当てにできない）に
 * 依存せずにこの効果を確かめるためである。
 */
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

      // ⭐ scoreThreshold を大きく下げ、below_threshold で候補が落ちることを心配せずに
      // score breakdown を直接読む（このテストが確かめたいのは freshness の値そのもの）。
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

      // 400日 / 720時間(半減期) ≈ 13.3 半減期 ⟹ legacy の freshness はごく小さい値
      // （affinity・decay・tagMatch・strength の上界がすべて1以下なので、total が
      // 0.1(既定 scoreThreshold)を超えないことは freshness だけで保証される）。
      expect(legacyFreshness).toBeLessThan(0.01);
      // eventAwareFreshness は occurredAt が無い記憶の freshness を厳密に1へ固定する
      // （`computeFreshness` の doc コメント、ADR 0300 §2）。
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
      expect(eventAware.memories[0]!.score.freshness).toBe(legacy.memories[0]!.score.freshness);
      expect(eventAware.memories[0]!.score.total).toBe(legacy.memories[0]!.score.total);
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
      // deterministic の complete() は最後のメッセージ(=組み立てたプロンプト)をそのまま
      // エコーするので、回答にはプロンプト自身が含まれる。
      expect(result.byPolicy.legacy.answer).toBe(result.byPolicy.legacy.prompt);
      expect(result.byPolicy.eventAwareFreshness.answer).toBe(
        result.byPolicy.eventAwareFreshness.prompt,
      );

      const aggregate = aggregateTimeWeightingResults([result]);
      // 1ケース×2方針ぶんのセルが立つ。
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
    // ⚠ この値そのものは `main` が動けば変わりうる（AGENTS.md「⚠ 数を、道具と生成物に
    // 焼き込まない」）。ここで固定しているのは「この PR のケース集合が前提にした値」の
    // 記録であり、`main` の正本を複製しているのではない——動いたらこのテストが赤くなり、
    // ケース集合の日数を設計し直す合図になる。
    expect(DEFAULT_HALF_LIFE_HOURS).toBe(720);
  });
});

afterAll(async () => {
  await closeTestClient();
});
