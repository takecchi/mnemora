import type { MemoryId, RecallId } from "./ids.js";
import type { Omission, RecalledMemory, RecalledScore, StageTrace } from "./recall.js";

/**
 * `Runtime.findCorrectionCandidates` の入出力。この口は `recall()` を1回呼んで「置き換わる相手の候補」を
 * 返すだけで、**書き込みは1件もせず、LLM は1回も呼ばない。**詳しくは `Runtime.findCorrectionCandidates` の doc。
 */

/**
 * `FindCorrectionCandidatesInput.limit` の既定値。実測の根拠は無い裁量値で、候補を人（または上位の
 * 判断ロジック）に見せて選ばせる前提で、一覧性を保てる小さな数にした。
 */
export const DEFAULT_CORRECTION_CANDIDATE_LIMIT = 3;

/** `Runtime.findCorrectionCandidates` への入力。 */
export interface FindCorrectionCandidatesInput {
  /** 訂正の発話そのもの。`RecallQuery.text` にそのまま渡す（要約も加工もしない）。 */
  text: string;
  /**
   * 返す候補の上限。**既定 {@link DEFAULT_CORRECTION_CANDIDATE_LIMIT}。**
   * `recall()` 自身の `RecallQuery.limit` とは**別の値**で、recall が広めに集めた後にこの口がさらに絞る。
   * 整数でない、または `1` 未満を渡すと `Runtime.findCorrectionCandidates` は `RangeError` を投げる
   * （`recall()` を呼ぶ前に落ちる）。
   */
  limit?: number | undefined;
  /**
   * 候補から除く memoryId。訂正の発話そのものを先に `observe()` していた場合の自己除外に使う
   * （`recall()` は訂正の発話から作られたばかりの Memory 自身を返しうる）。
   *
   * 大文字小文字は無視して突き合わせる（`@mnemora/postgres` は UUID を小文字で返すので、大文字で
   * 渡した id でも除外される）。
   *
   * ⚠ **配列で、要素はすべて文字列でなければならない**（ADR 0496）。裸の文字列や、文字列でない要素を含む配列は、
   * `Runtime.findCorrectionCandidates` が `recall()` を呼ぶ前に `TypeError` で断る（裸の文字列は1文字ずつの
   * 集合になり、何も除外されないため）。省略（`undefined`）は「除外なし」。
   *
   * ⚠ **順位（`CorrectionCandidate.recallRank`）は詰め直さない。**除外は `recall()` が返した並びに対する
   * 後処理であり、「recall の何位だったか」という事実は変えない。
   */
  excludeMemoryIds?: readonly MemoryId[] | undefined;
  /**
   * 内部で1回呼ぶ `recall()` へそのまま渡す `RecallQuery.activityCounting`。省略時 `"tenant"`
   * （[ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)）。
   */
  activityCounting?: "tenant" | "subject" | undefined;
}

/**
 * `FindCorrectionCandidatesResult.candidates` の1件。`RecalledMemory` の部分集合を並べ替えただけで、
 * `score`/`retrievedVia` は `recall()` が返したものをそのまま運ぶ。
 */
export interface CorrectionCandidate {
  /** 候補の Memory の id。 */
  memoryId: MemoryId;
  /** 候補の Memory の `digest`（`recall()` が返した値のまま）。 */
  digest: string;
  /**
   * 1始まり。**`recall()` が返した並びでの順位であり、`excludeMemoryIds` で除外した後に詰め直した順位ではない。**
   * 例えば1位を自己除外で落としたとき、次に残る候補の `recallRank` は「2」のまま。
   */
  recallRank: number;
  /**
   * `recall()` が返したスコアの内訳をそのまま運ぶ。**`affinityMeasured === false`
   * （連想枠・必須の同伴取得経由）の候補は `total` を持たない**
   * （[ADR 0352](../../../docs/decisions/0352-association-score-without-total.md)）。
   * `RecalledMemory.score`（{@link RecalledScore}）と同じ判別。
   */
  score: RecalledScore;
  /** `recall()` がどの経路で引いたか（`RecalledMemory.retrievedVia` のまま）。 */
  retrievedVia: RecalledMemory["retrievedVia"];
}

/** `Runtime.findCorrectionCandidates` の結果。 */
export interface FindCorrectionCandidatesResult {
  /** 内部で1回だけ呼んだ `recall()` の `recallId`。`Runtime.getRecall` へ渡せば、後から同じ内訳を引ける。 */
  recallId: RecallId;
  /** `recall()` が返した並びのうち、`excludeMemoryIds` で除外し `limit` で切ったもの。 */
  candidates: CorrectionCandidate[];
  /** `recall()` が返した `omitted` をそのまま運ぶ（この口自身は何も足さない）。 */
  omitted: Omission[];
  /** `recall()` の `explain` をそのまま運ぶ。 */
  explain: { stages: StageTrace[] };
  /**
   * `"candidates"` — `candidates` が1件以上。
   * `"no_candidates"` — `candidates` が0件（`recall()` が0件を返した、または `excludeMemoryIds` が全件を落とした）。
   * 「探していない」という第3の値は無い（この口は必ず `recall()` を1回呼ぶ）。`text` が文字列でない
   * （JavaScript や `as` で型を外したとき）と、`recall()` を呼ぶ前に `TypeError` で断る（ADR 0496）。
   * `""` は `recall()` の検証で例外になる。
   */
  outcome: "candidates" | "no_candidates";
  /** `recall()` が返した件数（`excludeMemoryIds` の除外・`limit` の適用より前）。 */
  recalledCount: number;
  /** `excludeMemoryIds` で落とした件数。 */
  excludedCount: number;
}

/**
 * zod スキーマは置かない。`*Schema` を並置するのは `recall()` の戻り値のように実行時検証される型だけで
 * （ADR 0098）、`Runtime` の操作の結果型には schema が無い。検証する相手が居ないまま schema だけ足すと、
 * 公開 API が増えるだけで何も守らない。
 */
