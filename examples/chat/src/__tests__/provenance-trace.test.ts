import { describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryStore, Observation, RecallResult } from "@mnemora/core";
import { resultContainsObservation } from "../provenance-trace.js";
import { buildMnemoraPrompt } from "../mnemora-path.js";

/**
 * Issue #496 完了条件3: 「同じ出典から答えの情報を欠く digest を作るケースで、出典到達が
 * 情報保持の証明ではないことを示す」。
 *
 * `resultContainsObservation`/`resolveExternalId`（`../provenance-trace.js`）は
 * `Memory.digest` を一切読まない——`memoryId → Memory.sourceObservationId →
 * Observation.externalId` だけを辿る。この歯は、そのことを**digest の中身を実際に
 * 変えて**固定する: 答えの情報を欠く digest と、答えをそのまま含む digest の両方に
 * 同じ `sourceObservationId` を持たせ、**どちらでも到達判定が true になる**ことを示す
 * （＝出典到達は情報保持の証明ではない）。
 *
 * ⭐ 陽性対照（答えを含む digest でも true）と陰性対照（別の出典なら false）を
 * 同じ検査の中に置く——「true が出た」だけでは、この探り棒が実際に区別している
 * ものが出典だけであることを示せない（`docs/autonomy.md` §2.2 の3番）。
 *
 * DB を使わない純粋な in-memory fake（`examples/chat/src/__tests__/compare-decay-clock.test.ts`
 * と同じ最小の偽物の作法）。`@mnemora/testkit` の `InMemoryMemoryStore` は
 * `packages/testkit/src/index.ts` が意図的に export していない
 * （プレースホルダ実装は公開 API ではない）ため、ここでは `get`/`getObservation` の
 * 2メソッドだけを持つ最小の fake を自分で組み立てる。
 */

const ctx: Ctx = { tenantId: "provenance-trace-test" };

const TARGET_EXTERNAL_ID = "ext-fact-statement";
const OTHER_EXTERNAL_ID = "ext-unrelated";

function buildFakeMemoryStore(
  memories: Record<string, Pick<Memory, "sourceObservationId"> & { digest: string }>,
  observations: Record<string, Pick<Observation, "externalId">>,
): MemoryStore {
  return {
    get: async (_ctx: Ctx, id: string) => {
      const m = memories[id];
      if (!m) return null;
      return { id, digest: m.digest, sourceObservationId: m.sourceObservationId } as Memory;
    },
    getObservation: async (_ctx: Ctx, id: string) => {
      const o = observations[id];
      if (!o) return null;
      return { id, externalId: o.externalId } as Observation;
    },
  } as unknown as MemoryStore;
}

describe("resultContainsObservation: 出典到達は digest の中身に依らない（Issue #496）", () => {
  it("答えの情報を欠く digest・答えをそのまま含む digest・別の出典の3件を並べ、区別しているのが出典だけであることを示す", async () => {
    const memoryStore = buildFakeMemoryStore(
      {
        // 陽性1（本題）: 要約に失敗し、答えの情報を一切持たない digest。
        // それでも sourceObservationId は正しい出典を指す。
        "mem-info-lost": {
          digest: "[要約失敗。内容は保持していません]",
          sourceObservationId: "obs-target",
        },
        // 陽性対照: 答え（「青」）をそのまま含む digest。同じ出典を指す。
        "mem-info-kept": {
          digest: "私の好きな色は青です。",
          sourceObservationId: "obs-target",
        },
        // 陰性対照: digest は答えを含むが、出典が別の Observation を指す。
        "mem-other-source": {
          digest: "私の好きな色は青です。",
          sourceObservationId: "obs-other",
        },
      },
      {
        "obs-target": { externalId: TARGET_EXTERNAL_ID },
        "obs-other": { externalId: OTHER_EXTERNAL_ID },
      },
    );

    // 陽性1: 情報を欠く digest でも、出典が一致すれば true。
    // ⟹ 出典到達は「情報が残った」ことの証明ではない（本題）。
    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-info-lost" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(true);

    // 陽性対照: 答えを含む digest でも結果は変わらず true。
    // ⟹ digest の中身が判定に影響していないことの確認（関数が本当に digest を
    //   見ていないことの裏付け）。
    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-info-kept" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(true);

    // 陰性対照: 同じ「答えを含む digest」でも、出典が別なら false。
    // ⟹ この探り棒が実際に区別しているのは出典であり、何にでも true を返す
    //   壊れた探り棒ではないことの確認。
    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-other-source" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(false);
  });
});

/**
 * Issue #498 完了条件4: 「同じ出典のまま答えの情報を欠落させた場合に、内容保持または
 * 回答評価が失敗することを確認する」。**逐語は選言（or）である。**
 *
 * ⭐ **示すもの（本題）**: `resultContainsObservation`（層1・出典到達）が `true` の
 * ままでも、`buildMnemoraPrompt`（`../mnemora-path.js`。`recall.memories[].digest` を
 * 並べるだけの純関数——LLM も DB も呼ばない）が実際に組み立てる、**モデルへ渡る文**
 * からは答えの語が落ちうる。出典到達（層1）と内容保持（層2）は別の検査でなければ
 * 区別できない、という Issue #498 の完了条件2 と同じ主張を、変異の形で固定する。
 *
 * ⛔ **示さないもの**: **評価器（`gradeAnswer`/judge）がこの欠落を捕まえられること。**
 * それが Issue #498 設計コメント §7 が意図した「回答評価が失敗する」側の陽性対照
 * であり、**この検査は judge を1度も走らせていない**。理由は機構的である
 * （`examples/chat/cassettes/answer.json` の `llm.entries` 67件は抽出26 + 回答生成24
 * （相異なる質問12件 × {naive, mnemora} の対、余り0件）+ judge17 に分かれ、回答生成の
 * 24件には変異後のプロンプトが1件も記録されていない——`packages/testkit/src/__fixtures__/cassette.ts`
 * の `llmCassetteKey` は `{system, messages}` を正準化した SHA-256 なので、`digest` を
 * 変異させれば鍵が変わり、`recorded` provider は例外を投げる。記録し直すには実 API と
 * 鍵が要り、それはオーナーの判断である——詳細は
 * [ADR 0236](../../../docs/decisions/0236-answer-retention-mutation-tested-not-recorded.md)）。
 * ⟹ 内容保持の側だけがこの検査の対象であり、**#498 はこれで閉じない。**
 *
 * ⛔ **もう一つ正直に書く**: 下の3番目のアサーション（`buildMnemoraPrompt` の出力に
 * 答えの語が無い）は、**それ単独ではほぼ同語反復である**——答えを含まない digest を
 * 渡せば答えを含まない文字列が返るのは、`buildMnemoraPrompt` が `digest` を
 * そのまま並べる純関数である以上ほぼ自明である。**この検査に値打ちを持たせているのは、
 * 2番目（層1は true のまま）との対比だけである。**「出典には届いているのに、
 * モデルへ渡る文からは答えが消えている」という食い違いこそが、Issue #496/#498 が
 * 指摘した「出典到達は情報保持の証明ではない」の実演になる。
 */
describe(
  "buildMnemoraPrompt vs resultContainsObservation: 出典到達は内容保持を保証しない" +
    "（Issue #498 完了条件4・内容保持の側。⛔ 回答評価は測らない——評価器(gradeAnswer/judge)を" +
    "1度も走らせていないため、§7 が意図した陽性対照は未達のままである）",
  () => {
    const ANSWER_WORD = "青";
    const DIGEST_WITH_ANSWER = `私の好きな色は${ANSWER_WORD}です。`;
    const DIGEST_INFO_LOST = "[要約失敗。内容は保持していません]";
    const MEMORY_ID = "mem-answer-retention";

    function buildFakeRecall(digest: string): RecallResult {
      return {
        recallId: "recall-answer-retention-test",
        memories: [
          {
            memoryId: MEMORY_ID,
            digest,
            retrievedVia: "ann",
          },
        ],
        omitted: [],
        index: { groups: [], totalInScope: 1, countKind: "exact" },
        usage: {},
        explain: { stages: [] },
      } as unknown as RecallResult;
    }

    it("digest から答えの語を落としても層1(出典到達)は true のままで、しかしモデルへ渡る文からは答えが消え、復元すると戻る", async () => {
      // 同じ memoryId・同じ sourceObservationId を保ったまま、digest だけを
      // 「情報を保持したまま」と「情報を欠落させた」の2通り用意する。
      const memoryStore = buildFakeMemoryStore(
        {
          [MEMORY_ID]: { digest: DIGEST_INFO_LOST, sourceObservationId: "obs-target" },
        },
        {
          "obs-target": { externalId: TARGET_EXTERNAL_ID },
        },
      );

      const recallInfoLost = buildFakeRecall(DIGEST_INFO_LOST);
      const recallInfoKept = buildFakeRecall(DIGEST_WITH_ANSWER);

      // 1 & 2. 層1（出典到達）: digest から答えの語を落としても、
      // sourceObservationId が変わっていなければ true のまま。
      // ⟹ 出典到達は情報保持の証明ではない（本題）。
      await expect(
        resultContainsObservation(memoryStore, ctx, recallInfoLost.memories, TARGET_EXTERNAL_ID),
      ).resolves.toBe(true);

      // 3. モデルへ渡る文（buildMnemoraPrompt の出力）には答えの語が無い。
      // ⛔ これ単独では同語反復に近い——値打ちは直前の(true のまま)との対比にある。
      expect(buildMnemoraPrompt(recallInfoLost)).not.toContain(ANSWER_WORD);

      // 4. 復元（digest に答えの語を戻す）すると、モデルへ渡る文にも答えが戻る。
      // ⟹ 緑に戻ることの確認。層1は最初から一貫して true のままである
      //   （情報の有無で出典到達の判定は動いていない）。
      expect(buildMnemoraPrompt(recallInfoKept)).toContain(ANSWER_WORD);
      await expect(
        resultContainsObservation(memoryStore, ctx, recallInfoKept.memories, TARGET_EXTERNAL_ID),
      ).resolves.toBe(true);
    });
  },
);
