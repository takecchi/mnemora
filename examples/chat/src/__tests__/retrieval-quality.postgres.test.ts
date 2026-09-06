import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PROBES, buildProbeSetConversation, findTopicKeywordViolations } from "../probe-set.js";
import { resolveExternalId, runRetrievalQualityArm } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { formatNoApiCallsNotice } from "../usage-meter.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * retrieval-quality の「仕組み」だけを、擬似 provider(arm A 相当)だけで検査する
 * (PR 本文 (F))。
 *
 * **⚠ 品質の数値(MRR が幾つ以上、goldRank が何位以内、等)は assert しない。**
 * `DeterministicEmbeddingProvider` は文字コードの合計から機械的にベクトルを作るだけで
 * 意味的な類似度を持たない(`packages/testkit` 自身のコメントの通り)。ここで固定して
 * しまうと、後で本物の embedding/LLM の数字が悪かったときにこの歯が「ずっと緑」のまま
 * 嘘をつく。検査するのは以下の3点——(1) gold の系譜が memory → observation まで
 * 実際に辿れること、(2) haystack が probe の話題語と機械的に重ならないこと、
 * (3) outbox が実際に干上がるまで処理され、既定の `tick()` 1回では処理しきれない
 * 件数だったこと(背景2)——という「仕組み」だけである。
 *
 * **⚠ 本物の API は叩かない**。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を明示的に
 * `"deterministic"` に固定して `createExampleRuntime` を呼ぶ——実行環境に
 * たまたま `OPENAI_API_KEY` が設定されていても、この歯は本物には倒れない。
 */
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

      // 存在しない memoryId では null を返す(黙って何かに読み替えない)。
      //
      // ⚠ ここで渡すのは「UUID として妥当だが存在しない」id である。当初は
      // "does-not-exist" という文字列を渡していたが、`PostgresMemoryStore.get` は
      // uuid 列への比較をそのまま投げるため `invalid input syntax for type uuid` で
      // 例外になり、この検査自体が落ちた。`resolveExternalId` 側で例外を握り潰す案は
      // 採らない——DB の異常を「辿れなかった」に読み替えると、系譜が壊れていることを
      // 見逃す。**辿れない(null)と、壊れている(例外)は別物である。**
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

    // 1件ずつ内容が違う(同じ文が繰り返されると擬似 embedding が同一ベクトルになり、
    // 順位付けの試験にならないため)。
    expect(new Set(haystackTexts).size).toBe(haystackTexts.length);

    // gold は冒頭付近、haystack はその後ろ(externalId の並び順で確認する)。
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
        // haystackSize=55: 7 probe × (gold+distractor) の14件と合わせて69件。
        // `DeterministicLLMProvider` は1発話につき必ず1件の Memory を作るため、
        // embed ジョブも69件になる——`packages/core/src/runtime.ts` の
        // `DEFAULT_TICK_LIMIT`(50)を確実に超える件数にしてあり、既定の tick() を
        // 1回しか呼ばない実装(`mnemora-path.ts` の `ingestConversation`)だったら
        // 51件目以降が埋め込まれないまま残ることを、この歯自身が実際に踏んで示す。
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

        // 干上がるまで処理し切っている(1件も pending のまま残っていない)。
        expect(report.ingest.drain.totalProcessed).toBe(expectedObservationCount);
        expect(report.ingest.drain.totalFailed).toBe(0);

        // 既定の tick() 1回(limit=50)では処理しきれない件数だった、という背景2の再現。
        expect(report.ingest.drain.firstTickProcessed).toBe(50);
        expect(report.ingest.drain.ticks).toBeGreaterThanOrEqual(2);
        expect(report.ingest.singleTickWouldHaveStalled).toBe(true);

        // probe ごとの指標が計算されている(仕組みの検査——値そのものは assert しない)。
        expect(report.probes).toHaveLength(PROBES.length);
        for (const probe of report.probes) {
          expect(Array.isArray(probe.omittedKinds)).toBe(true);
          // 全発話が1件ずつ Memory になり、期限切れ等のフィルタも無いので、
          // スコープ内総数は常に総 Observation 数と一致するはず(擬似 provider・
          // 埋め込み完了後の同一スコープなので数え方のブレは無い)。
          expect(probe.totalInScope).toBe(expectedObservationCount);
          // hit10 は goldRank が存在することと同値(既定 limit=10)。
          expect(probe.hit10).toBe(probe.goldRank !== null);
          expect(probe.reciprocalRank).toBe(probe.goldRank !== null ? 1 / probe.goldRank : 0);
        }

        // MRR は常に [0, 1] に収まる(何位に来たかという「値」そのものは assert しない)。
        for (const mrr of [report.mrrOverall, report.mrrLexicalControl, report.mrrNonLexical]) {
          expect(mrr).toBeGreaterThanOrEqual(0);
          expect(mrr).toBeLessThanOrEqual(1);
        }

        // 擬似 provider で走ったことが、レポートの文面からも明示されている
        // (0 を黙って出さない、という PR 本文 (A) の要求のテスト)。
        // ADR 0051 でモードを引数に取るようになったため、この arm の実際のモードを渡す。
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
});

afterAll(async () => {
  await closeTestClient();
});
