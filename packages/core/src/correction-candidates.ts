import type { MemoryId, RecallId } from "./ids.js";
import type { Omission, RecalledMemory, RecalledScore, StageTrace } from "./recall.js";

/**
 * `Runtime.findCorrectionCandidates`（Issue #369 (C)「訂正の口」）の入出力。
 *
 * **この口が何であり、何でないか**は `runtime.ts` の `Runtime.findCorrectionCandidates`
 * の doc コメントを見ること——ここには型の形だけを置く。要約: 採用側が「これは訂正だ」と
 * 宣言したときに、既存の `recall()` を1回呼んで「置き換わる相手の候補」を返すだけの口。
 * **書き込みは1件もしない。LLM は1回も呼ばない。新しい閾値も新しい探索も持たない。**
 */

/**
 * `FindCorrectionCandidatesInput.limit` の既定値。
 *
 * 3件という数字自体に実測の根拠は無い——`DEFAULT_CONSOLIDATE_MIN_AFFINITY`/
 * `DEFAULT_REFLECT_MIN_AFFINITY`（`runtime.ts`）と同じく、Phase 1 の裁量値である。
 * 採用側は候補を人（または上位の判断ロジック）に見せて選ばせる前提であり、
 * 一覧性を保てる小さな数を既定にした。緩めるかどうかは実測してから判断する。
 */
export const DEFAULT_CORRECTION_CANDIDATE_LIMIT = 3;

/** `Runtime.findCorrectionCandidates` への入力。 */
export interface FindCorrectionCandidatesInput {
  /**
   * 訂正の発話そのもの。`RecallQuery.text` にそのまま渡す——ここで要約も加工もしない
   * （`recall()` に新しい「似ている」の判定を作らない、という設計の芯そのもの）。
   */
  text: string;
  /**
   * 返す候補の上限。**既定 {@link DEFAULT_CORRECTION_CANDIDATE_LIMIT}。**
   * `recall()` 自身の `RecallQuery.limit`（既定 `DEFAULT_RECALL_LIMIT` = 10）とは
   * **別の値**——recall がまず広めに候補を集めた後、この口がさらに絞る。
   * 整数でない、または `1` 未満を渡すと `Runtime.findCorrectionCandidates` は
   * `RangeError` を投げる（書き込みはおろか `recall()` すら呼ばない前に落ちる）。
   */
  limit?: number | undefined;
  /**
   * 候補から除く memoryId。訂正の発話そのものを先に `observe()` していた場合の
   * 自己除外に使う——`recall()` は「訂正の発話から作られたばかりの Memory」自身を
   * 候補として返しうるため、それを候補集合から落としたい呼び出し側のための欄。
   *
   * 大文字小文字は無視して突き合わせる（`@mnemora/postgres` は UUID を小文字で返すので、大文字で
   * 渡した id でも除外される）。
   *
   * ⚠ **配列で、要素はすべて文字列でなければならない**（ADR 0496）。裸の文字列や、文字列でない要素を含む配列は、
   * `Runtime.findCorrectionCandidates` が `recall()` を呼ぶ前に `TypeError` で断る（以前は裸の文字列が1文字ずつの
   * 集合になり、何も除外されずに通った）。省略（`undefined`）は「除外なし」。
   *
   * ⚠ **順位（`CorrectionCandidate.recallRank`）は詰め直さない。**除外は
   * `recall()` が返した並びに対する後処理であり、順位という「recall の何位だったか」
   * という事実そのものは変えない（{@link CorrectionCandidate.recallRank} の doc参照）。
   */
  excludeMemoryIds?: readonly MemoryId[] | undefined;
  /**
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: 内部で1回呼ぶ `recall()` へそのまま渡す
   * `RecallQuery.activityCounting`。省略時 `"tenant"`（本 ADR 以前と1バイトも
   * 変わらない挙動）。
   */
  activityCounting?: "tenant" | "subject" | undefined;
}

/**
 * `FindCorrectionCandidatesResult.candidates` の1件。
 *
 * `RecalledMemory` の部分集合を並べ替えただけであり、新しい値（新しいスコア・新しい
 * 「似ている」の判定）を1つも作っていない——`score`/`retrievedVia` は `recall()` が
 * 返したものをそのまま運ぶ。
 */
export interface CorrectionCandidate {
  /** 候補の Memory の id。 */
  memoryId: MemoryId;
  /** 候補の Memory の `digest`（`recall()` が返した値のまま）。 */
  digest: string;
  /**
   * 1始まり。**`recall()` が返した並びでの順位であり、`excludeMemoryIds` で除外した後に
   * 詰め直した順位ではない。**
   *
   * 詰め直さない理由: 採用側が「これは recall の何位だったか」をそのまま人（またはログ）
   * に説明できるようにするため（`docs/north-star.md` 迷ったときの問い3「なぜそれを
   * 選んだのかを、後から説明できるか」）。例えば1位を自己除外で落としたとき、次に残る
   * 候補の `recallRank` は「2」のままである——「1位が無くなったので繰り上がって1位」
   * という別の情報（recall の生の結果には無かった情報）を、この口が勝手に作り出さない。
   */
  recallRank: number;
  /**
   * `recall()` が返したスコアの内訳をそのまま運ぶ。**2026-09-29（Issue #548 方向2、
   * [ADR 0352](../../../docs/decisions/0352-association-score-without-total.md)）：
   * `affinityMeasured === false`（連想枠・必須の同伴取得経由）の候補は `total` を
   * 持たない**——`RecalledMemory.score`（{@link RecalledScore} の doc）と同じ判別。
   */
  score: RecalledScore;
  /** `recall()` がどの経路で引いたか（`RecalledMemory.retrievedVia` のまま）。 */
  retrievedVia: RecalledMemory["retrievedVia"];
}

/** `Runtime.findCorrectionCandidates` の結果。 */
export interface FindCorrectionCandidatesResult {
  /**
   * 内部で1回だけ呼んだ `recall()` の `recallId`。`Runtime.getRecall` へ渡せば、
   * 後から同じ内訳（`score`/`retrievedVia`/`companionOf`/`associationOf`）を引ける
   * （`getRecall` の doc コメント参照）。
   */
  recallId: RecallId;
  /** `recall()` が返した並びのうち、`excludeMemoryIds` で除外し `limit` で切ったもの。 */
  candidates: CorrectionCandidate[];
  /** `recall()` が返した `omitted` をそのまま運ぶ（この口自身は何も足さない）。 */
  omitted: Omission[];
  /** `recall()` の `explain` をそのまま運ぶ。 */
  explain: { stages: StageTrace[] };
  /**
   * `"candidates"` — `candidates` が1件以上。
   * `"no_candidates"` — `candidates` が0件（`recall()` が0件を返した、または
   * `excludeMemoryIds` が全件を落とした）。**`outcome` に「探していない」という第3の値は無い**
   * ——この口は必ず `recall()` を1回呼ぶ。`text` が文字列でない（JavaScript や `as` で型を外したとき）と、
   * `recall()` を呼ぶ前に `TypeError` で断る（ADR 0496。以前は `undefined` が `no_candidates` になった）。
   * `""` は `recall()` の検証で例外になる。`Runtime.findCorrectionCandidates` の doc コメントも参照。
   */
  outcome: "candidates" | "no_candidates";
  /** `recall()` が返した件数（`excludeMemoryIds` の除外・`limit` の適用より前）。 */
  recalledCount: number;
  /** `excludeMemoryIds` で落とした件数。 */
  excludedCount: number;
}

/**
 * ⚠ **zod スキーマは置かない。**
 *
 * このリポジトリで `*Schema` を並置しているのは `recall.ts` / `observation.ts` の型で
 * あり、**`recall()` の戻り値が実際に実行時検証される**（`RecallOutputValidation`、
 * ADR 0098）ためである。⟹ **Runtime の操作の結果型には schema が1つも無い**——
 * `RestoreSupersededResult`（ADR 0230）・`MarkContestedResult`（ADR 0134）・
 * `ForgetResult`・`ConsolidationResult` のいずれも持っていない。**この口も同じ立場である。**
 *
 * ⛔ **検証する相手が居ないまま schema だけ足さない。** それは公開 API を増やすだけで
 * 何も守らず、`satisfies z.ZodType<T>` を付けなければ型との一致すら検査されない
 * （ADR 0181 / `__tests__/schema-type-equals-parity.test.ts` が守っているのはそこである）。
 */
