import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PROBES, buildProbeSetConversation, findTopicKeywordViolations } from "../probe-set.js";
import { armHeadline, resolveExternalId, runRetrievalQualityArm } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { assertAffinityMeasured } from "../recalled-score.js";
import { formatNoApiCallsNotice } from "../usage-meter.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 品質の数値（MRR・goldRank）は assert しない。擬似 embedding は意味的な類似度を持たず、固定すると本物の数字が悪くても歯がずっと緑のままになる。
// MNEMORA_LLM/MNEMORA_EMBEDDING を deterministic に固定する。環境に OPENAI_API_KEY が在っても本物へ倒れない。
describe("examples/chat: retrieval-quality の仕組み(擬似 provider・本物の Postgres)", () => {
  it("resolveExternalId は observe() した externalId まで memory → observation を遡れる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      const ctx: Ctx = { tenantId: "retrieval-quality-test-traceback" };
      const observed = await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: "これは系譜を辿るための検査用の発話です。",
        externalId: "test-external-42",
      });
      expect(observed.memoryIds).toHaveLength(1);

      const externalId = await resolveExternalId(handle.memoryStore, ctx, observed.memoryIds[0]!);
      expect(externalId).toBe("test-external-42");

      // 存在しない id は「UUID として妥当だが無い」id を渡す。文字列だと PostgresMemoryStore.get が uuid 比較で例外になる。
      // resolveExternalId で例外を握り潰さない。DB の異常を「辿れなかった」に読み替えると系譜の破損を見逃す。
      const missing = await resolveExternalId(
        handle.memoryStore,
        ctx,
        "00000000-0000-4000-8000-000000000000",
      );
      expect(missing).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("buildProbeSetConversation の haystack は probe の話題語と機械的に重ならない", () => {
    const utterances = buildProbeSetConversation(30);
    const haystackTexts = utterances.filter((u) => u.kind === "haystack").map((u) => u.text);
    expect(haystackTexts).toHaveLength(30);
    expect(findTopicKeywordViolations(haystackTexts)).toEqual([]);

    // 1件ずつ内容を変える。同じ文だと擬似 embedding が同一ベクトルになり、順位付けの試験にならない。
    expect(new Set(haystackTexts).size).toBe(haystackTexts.length);

    const goldIndices = utterances
      .map((u, i) => (u.kind === "gold" ? i : -1))
      .filter((i) => i >= 0);
    const firstHaystackIndex = utterances.findIndex((u) => u.kind === "haystack");
    for (const goldIndex of goldIndices) {
      expect(goldIndex).toBeLessThan(firstHaystackIndex);
    }
  });

  it(
    "runRetrievalQualityArm は outbox を干上がるまで処理し、既定の tick() 1回では " +
      "処理しきれない件数だったことを報告し、probe ごとの指標を計算する",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const haystackSize = 55;
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-a",
          tenantId: "retrieval-quality-test-arm-a",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize,
        });

        const expectedObservationCount = PROBES.length * 2 + haystackSize;
        expect(report.ingest.observationCount).toBe(expectedObservationCount);

        expect(report.ingest.drain.totalProcessed).toBe(expectedObservationCount);
        expect(report.ingest.drain.totalFailed).toBe(0);

        expect(report.ingest.drain.firstTickProcessed).toBe(50);
        expect(report.ingest.drain.ticks).toBeGreaterThanOrEqual(2);
        expect(report.ingest.singleTickWouldHaveStalled).toBe(true);

        expect(report.probes).toHaveLength(PROBES.length);
        for (const probe of report.probes) {
          expect(Array.isArray(probe.omittedKinds)).toBe(true);
          expect(probe.totalInScope).toBe(expectedObservationCount);
          expect(probe.hit10).toBe(probe.goldRank !== null);
          expect(probe.reciprocalRank).toBe(probe.goldRank !== null ? 1 / probe.goldRank : 0);
        }

        for (const mrr of [report.mrrOverall, report.mrrLexicalControl, report.mrrNonLexical]) {
          expect(mrr).toBeGreaterThanOrEqual(0);
          expect(mrr).toBeLessThanOrEqual(1);
        }

        expect(report.usageReport).toBe(
          formatNoApiCallsNotice({
            llmMode: report.llmMode,
            embeddingMode: report.embeddingMode,
          }),
        );
      } finally {
        await handle.close();
      }
    },
  );

  it(
    "🔴 [ADR 0108] 既定の channels(=ann のみ)では、返った候補のどの行にも " +
      "score.lexicalMatch 欄が現れない — 現れたらこの歯が赤くなる",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-adr-0108",
          tenantId: "retrieval-quality-test-arm-adr-0108",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize: 20,
        });

        const totalRecalledRows = report.probes.reduce((sum, p) => sum + p.recalledRows, 0);
        const totalLexicalMatchRows = report.probes.reduce((sum, p) => sum + p.lexicalMatchRows, 0);

        expect(totalRecalledRows).toBeGreaterThan(0);

        expect(
          totalLexicalMatchRows,
          "この歯が赤いのは、欠陥が入ったからではない。" +
            "ベンチマークが語彙チャンネルを使う構成に変わった、という意味である" +
            "(examples/chat の Runtime に LexicalStore が配線された、または " +
            "runRetrievalQualityArm が recall() へ channels:['ann','lexical'] 等を" +
            "渡すようになった)。⟹ 意図した変更なら、この歯を更新したうえで " +
            "hit@1 を測り直すこと(それがこの歯の目的である。ADR 0108)。" +
            "⛔ 歯を消すだけにしないこと。",
        ).toBe(0);
      } finally {
        await handle.close();
      }
    },
  );

  // 日本語 probe（runRetrievalQualityArm）は使わない。日本語クエリは本文側のトークン境界で段1が0件になる（配線の欠陥ではない）。ASCII クエリで配線を測る（ADR 0148）。
  it(
    "🟢 [ADR 0148] channels:['ann','lexical'] を明示すれば、ASCII クエリで " +
      "score.lexicalMatch 欄が現れる — examples/chat の Runtime に LexicalStore が" +
      "配線されていることを直接示す",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const ctx: Ctx = { tenantId: "retrieval-quality-test-lexical-channel" };
        await handle.runtime.observe(ctx, {
          kind: "utterance",
          text: "We are using TypeScript for this project's backend.",
          externalId: "lexical-channel-ascii-fact",
        });

        const result = await handle.runtime.recall(ctx, {
          text: "TypeScript",
          channels: ["ann", "lexical"],
        });

        expect(result.memories.length).toBeGreaterThan(0);

        for (const m of result.memories) {
          assertAffinityMeasured(m.score);
        }
        const lexicalMatchRows = result.memories.filter((m) => {
          assertAffinityMeasured(m.score);
          return m.score.lexicalMatch !== undefined;
        });
        expect(
          lexicalMatchRows.length,
          "この歯が赤いのは、examples/chat の Runtime から LexicalStore の配線が" +
            "外れた(runtime-factory.ts の createRuntime() に lexicalStore を渡さなく" +
            "なった)、または packages/core 側の語彙チャンネルの契約が壊れたことを意味する。" +
            "⟹ ADR 0148 の主張(配線されている)が崩れている。",
        ).toBeGreaterThan(0);
        for (const memory of lexicalMatchRows) {
          assertAffinityMeasured(memory.score);
          expect(memory.score.lexicalMatch).toBeGreaterThan(0);
          expect(memory.score.lexicalMatch).toBeLessThanOrEqual(1);
        }
      } finally {
        await handle.close();
      }
    },
  );

  // channels: ["lexical"] だけを渡して ANN を落とす。options.channels が recall() に届いていなければ ANN が生きて候補が返り、赤になる。
  it(
    "🟢 [ADR 0148] runRetrievalQualityArm に channels:['lexical'](ann を含まない)を渡すと、" +
      "日本語 probe 7件はどれも候補0件になる — options.channels が recall() まで" +
      "実際に届いていることの証拠",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-adr-0148-lexical-only",
          tenantId: "retrieval-quality-test-arm-adr-0148-lexical-only",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize: 20,
          channels: ["lexical"],
        });

        expect(report.channels).toEqual(["lexical"]);

        const totalRecalledRows = report.probes.reduce((sum, p) => sum + p.recalledRows, 0);
        expect(
          totalRecalledRows,
          "この歯が赤い(候補が返っている)のは、runRetrievalQualityArm が " +
            "options.channels を recall() へ渡さなくなった(既定 ['ann'] のまま走っている) " +
            "ことを意味する。⟹ ADR 0148 の配線の前提が崩れている——" +
            "'retrieval-quality.ts の recall() 呼び出しを確認すること。",
        ).toBe(0);
      } finally {
        await handle.close();
      }
    },
  );

  it(
    "🔴 [ADR 0109] tagMatch/strength はどの probe でも候補間で1通り(=1)、" +
      "decay===freshness は全行で厳密等価 — この前提が崩れたらこの歯が赤くなる",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-adr-0109",
          tenantId: "retrieval-quality-test-arm-adr-0109",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize: 20,
        });

        const headline = armHeadline(report);

        const failureMeaning =
          "この歯が赤いのは欠陥が入ったからではない。ベンチの前提が変わったという" +
          "意味である——具体的には recall() に tags が渡されるようになった／" +
          "Memory.strength に 1 以外が書かれるようになった／occurredAt か " +
          "lastReinforcedAt が埋まるようになった(＝ decay と freshness の起点が" +
          "分かれた)。⟹ 意図した変更なら、この歯を更新したうえで順位を測り直すこと" +
          "(それがこの歯の目的である。ADR 0109)。⛔ 歯を消すだけにしないこと。";

        expect(headline.recalledRows, failureMeaning).toBeGreaterThan(0);

        for (const probe of report.probes) {
          const tagMatch = probe.termSpreads.find((s) => s.term === "tagMatch");
          expect(tagMatch, failureMeaning).toBeDefined();
          expect([tagMatch!.distinctCount, tagMatch!.min, tagMatch!.max], failureMeaning).toEqual([
            1, 1, 1,
          ]);

          const strength = probe.termSpreads.find((s) => s.term === "strength");
          expect(strength, failureMeaning).toBeDefined();
          expect([strength!.distinctCount, strength!.min, strength!.max], failureMeaning).toEqual([
            1, 1, 1,
          ]);
        }

        expect(headline.decayFreshnessDifferentRows, failureMeaning).toBe(0);
        expect(headline.decayFreshnessEqualRows, failureMeaning).toBe(headline.recalledRows);
      } finally {
        await handle.close();
      }
    },
  );
});

afterAll(async () => {
  await closeTestClient();
});
