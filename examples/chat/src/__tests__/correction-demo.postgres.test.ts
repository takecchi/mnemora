import { afterAll, describe, expect, it } from "vitest";
import type { RecallRecordMemory } from "@mnemora/core";
import {
  checkCorrectionDemo,
  checkCorrectionOmission,
  runCorrectionDemo,
} from "../correction-demo.js";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `examples/chat` から `Runtime.markContested`/`Runtime.resolveContested` を実際に呼び、
 * 本物の Postgres に対して「間違いを正すと、古いほうが先に出てこなくなる」（北極星 項目5）
 * を実測する歯（Issue #303 受け入れ条件2・3）。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装（`backfill.postgres.test.ts`/
 * `scope.postgres.test.ts` と同じ規約——`env: {}` を渡し `OPENAI_API_KEY` の有無に関わらず
 * deterministic モードを強制する）。DB は擬似物で代替しない。
 *
 * **⚠ この作業環境では `DATABASE_URL` は既定で無い**（`docs/autonomy.md` §1.1）。
 * CI の `example-chat` ジョブと「ルートの test 門の DB 段」（`root-gate-db-stage`）が
 * 継続的な実測の場になる。**PR #320 の CI 失敗を引き継いだ修正作業（Issue #303）では、
 * `initdb` で一時的な Postgres 17 + pgvector クラスタをローカルに立てて実際にこの歯を
 * 実行し、赤（`afterMarkCompanionRetrieval` が false）→修正→緑を手元で確認した**
 * （`docs/decisions/0162-correction-scenario-example-chat.md` 決定5「測ったこと」参照）。
 */
describe("examples/chat: correction（markContested → resolveContested、本物の Postgres）", () => {
  it("markContested で対になった2件は recall で隣接して出て、resolveContested(supersede) 後は古いほうが消える", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");

      const result = await runCorrectionDemo(
        handle.runtime,
        { tenantId: "example-chat-correction-test" },
        CORRECTION_SCENARIO,
        // 🔴 「記録済みの採用者の判断」——findCorrectionCandidates が返す候補の並びから
        // 導いたものではない(ADR 0232 引き受けた負債1への応答)。
        { chosenExternalId: CORRECTION_SCENARIO.contestedPair.firstExternalId },
      );

      // 【発見の段】本物の Postgres + pgvector + 決定的 provider に対して実際に
      // findCorrectionCandidates を呼んでいる。書き込み・LLM は起きない
      // (findCorrectionCandidates 自身の契約、ADR 0232)。指名(original)が候補に
      // 実際に見つかったので、選択の段が resolved まで進む。
      expect(result.outcome).toBe("resolved");
      expect(result.discovery.candidates.length).toBeGreaterThan(0);
      expect(result.chosenId).toBe(result.originalId);
      expect(result.chosenRecallRank).not.toBeNull();
      expect(result.discovery.candidates.some((c) => c.memoryId === result.originalId)).toBe(true);

      const check = checkCorrectionDemo(result);

      // 前提: markContested/resolveContested がそもそも対応している(supported)こと。
      expect(result.markOutcomeKind).toBe("contested");
      expect(result.resolveOutcomeKind).toBe("resolved");
      expect(check.markSucceeded).toBe(true);
      expect(check.resolveSucceeded).toBe(true);

      // markContested 直後: `recall({ limit: 1 })` でも両方が隣接して出て、
      // 段2で limit に自然に残らなかったほう(まだ勝敗は付いていない——両方 contested。
      // どちらが残るかはスコアのランキング次第であり、resolveContested の勝者とは無関係)は
      // mandatory_companion として強制的に連れてこられる(ADR 0162 決定5)。
      expect(result.beforeMark!.memories.length).toBeGreaterThan(0);
      expect(check.afterMarkBothPresent).toBe(true);
      expect(check.afterMarkCompanionRetrieval).toBe(true);
      expect(check.afterMarkCompanionOfOther).toBe(true);

      // 🔑 北極星の核心: resolveContested(supersede) の後、古いほう(original)は
      // 二度と recall に出てこない。
      expect(check.afterResolveOriginalAbsent).toBe(true);
      expect(check.afterResolveCorrectionPresent).toBe(true);
      expect(result.afterResolve!.memories.length).toBe(1);

      // 🔴 Issue #374: 「消えた」(machine の都合で superseded として棚上げされた)と
      // 「最初から無かった」を区別する(北極星 項目6)。`afterResolveOriginalAbsent` は
      // `memories` 配列に居ないことしか見ないので、ここでは `omitted` 側に
      // 実際に `condition: "superseded"` が記録されていることまで見る。
      const omissionCheck = checkCorrectionOmission(result);
      expect(omissionCheck.afterResolveOriginalOmittedAsSuperseded).toBe(true);
      expect(result.afterResolve!.omitted).toContainEqual(
        expect.objectContaining({ kind: "filtered", condition: "superseded" }),
      );

      // 🔴 Issue #369 チェックボックス: 選んだ根拠(recallId・順位・候補の数・どちらへ
      // 倒したか)が、実際に memory_events.meta.note へ届いていることを、本物の
      // EventStore.list() で読み戻して検査する(「渡した」ではなく「残った」を測る)。
      const ctx = { tenantId: "example-chat-correction-test" };
      const originalEvents = await handle.eventStore.list(ctx, { memoryId: result.originalId });
      // markContested(kind='updated', meta.reason='contested') と
      // resolveContested(kind='superseded', meta.reason='contested_resolved')の
      // 2件がoriginalId側に積まれているはず(original は resolveContested の敗者)。
      expect(originalEvents.length).toBeGreaterThanOrEqual(2);
      const contestedEvent = originalEvents.find((e) => e.meta.reason === "contested");
      const resolvedEvent = originalEvents.find((e) => e.meta.reason === "contested_resolved");
      expect(contestedEvent).toBeDefined();
      expect(resolvedEvent).toBeDefined();

      for (const event of [contestedEvent, resolvedEvent]) {
        const note = event!.meta.note;
        expect(typeof note).toBe("string");
        expect(note as string).toContain(`recallId=${result.discovery.recallId}`);
        expect(note as string).toContain(`chosenRecallRank=${result.chosenRecallRank}`);
        expect(note as string).toContain(`candidates=${result.discovery.candidates.length}`);
        expect(note as string).toContain("winner=correction");
      }

      // 🔴 「両方から辿れる」の橋を実際に渡る: meta.note から recallId を取り出し、
      // Runtime.getRecall へ渡すと RecallResult.explain と同じ形(stages)が引ける。
      const noteText = contestedEvent!.meta.note as string;
      const bridgedRecallId = /recallId=([^ /]+)/.exec(noteText)?.[1];
      expect(bridgedRecallId).toBe(result.discovery.recallId);
      const record = await handle.runtime.getRecall(ctx, bridgedRecallId!);
      expect(record).not.toBeNull();
      expect(Array.isArray(record!.explain.stages)).toBe(true);

      // 🔴 チェックボックスの逐語は「スコア・順位・候補の数・どちらへ倒したか」である。
      // 順位/候補の数/どちらへ倒したかは meta.note が直接持つ(上)。⭐ スコアは meta.note には
      // 載せず、この橋の先から引く(ADR の「score.total を載せない」判断)。⟹ その「引ける」を
      // 主張のままにせず実測する——さもないと逐語の4つのうち1つが測られていないまま残る。
      expect(record!.returnedMemories.breakdownCaptured).toBe(true);
      const chosenInRecall = record!.returnedMemories.memories.find(
        (m) => m.memoryId === result.chosenId,
      );
      expect(chosenInRecall).toBeDefined();
      expect(typeof (chosenInRecall as RecallRecordMemory).score.total).toBe("number");
    } finally {
      await handle.close();
    }
  });

  it("choice を渡さない ⟹ outcome=awaiting_choice、書き込み0件(markContested/resolveContestedのどちらも呼ばれない)", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "example-chat-correction-test-no-choice" };
      const result = await runCorrectionDemo(handle.runtime, ctx);

      expect(result.outcome).toBe("awaiting_choice");
      expect(result.chosenId).toBeNull();
      expect(result.beforeMark).toBeNull();
      expect(result.afterMark).toBeNull();
      expect(result.afterResolve).toBeNull();

      // 🔴 候補は本物の recall から実際に返っている(棄権していない)——それでも
      // 書き込みには進んでいない。B群の危険をそのまま体現する経路。
      expect(result.discovery.candidates.length).toBeGreaterThan(0);

      // markContested が一度も呼ばれていないことを、広い limit で改めて recall して
      // 確認する——markContested を呼んでいれば、対は「両方 contested」になり、
      // limit を超えて強制的に連れてこられる(mandatory_companion)。呼んでいなければ、
      // 2件はただ独立に自然な順位で出るだけで、どちらも mandatory_companion にはならない。
      const recheck = await handle.runtime.recall(ctx, { text: result.scenario.query, limit: 10 });
      const recheckIds = recheck.memories.map((m) => m.memoryId).sort();
      expect(recheckIds).toEqual([result.originalId, result.correctionId].sort());
      expect(recheck.memories.every((m) => m.retrievedVia !== "mandatory_companion")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("宣言(contestedPair.winnerExternalId)を original 側にすると、original が生き残り correction が消える(順序規則ではないことの実測)", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const reversedScenario = {
        ...CORRECTION_SCENARIO,
        original: {
          ...CORRECTION_SCENARIO.original,
          externalId: "correction-demo-reversed-original",
        },
        correction: {
          ...CORRECTION_SCENARIO.correction,
          externalId: "correction-demo-reversed-correction",
        },
        contestedPair: {
          firstExternalId: "correction-demo-reversed-original",
          secondExternalId: "correction-demo-reversed-correction",
          // 宣言だけを逆にする——observe() の順序(original が先)は変えていない。
          winnerExternalId: "correction-demo-reversed-original",
        },
      };

      const result = await runCorrectionDemo(
        handle.runtime,
        { tenantId: "example-chat-correction-test-reversed" },
        reversedScenario,
        // 指名は変わらず「original 側」——ここでは reversedScenario.contestedPair
        // .firstExternalId が指す reversed-original の externalId(記録済みの判断)。
        { chosenExternalId: reversedScenario.contestedPair.firstExternalId },
      );

      expect(result.outcome).toBe("resolved");
      // observe() の順序は変わらない(original が先に呼ばれる)。
      expect(result.originalId).toBeDefined();
      // それでも、宣言どおり original が生き残る。
      const finalIds = result.afterResolve!.memories.map((m) => m.memoryId);
      expect(finalIds).toContain(result.originalId);
      expect(finalIds).not.toContain(result.correctionId);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
