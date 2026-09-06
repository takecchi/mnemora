import { defaultDecayStrategy } from "./decay.js";
import type { ScoreBreakdown } from "../recall.js";

/**
 * ScoringStrategy — Phase 1・純関数（docs/architecture.md §5.7、docs/recall.md §7）。
 *
 * docs は「減衰 × 類似度 × タグ一致 × 鮮度 × 強度を掛け合わせる」ことと、
 * 「鮮度スコアは occurred_at ?? recorded_at を使い、減衰は last_reinforced_at を使う」
 * ことだけを規定し、各要素の具体的な計算式までは規定していない。以下の実装は
 * その制約の範囲で選んだ Phase 1 の既定であり、`ScoringStrategy` を差し替えれば
 * 別の式を使える。
 *
 * - `decay`（時間減衰）と `strength`（生の強度）を分けて掛ける。`decay` は
 *   `defaultDecayStrategy.strengthAt` を `strength = 1` で呼んだ時間減衰係数のみを表し、
 *   生の強度は `total` の計算で別要素として掛ける（二重に強度を織り込まない）。
 * - `freshness` は同じ減衰関数を `occurredAt ?? recordedAt` を起点に、`strength = 1` で
 *   呼んで求める（「鮮度は occurred_at ?? recorded_at を使う」という規定を満たす）。
 *   **ただし 1 で頭打ちにする**（`MAX_FRESHNESS`。[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md)）。
 * - `tagMatch` はクエリタグが無ければ中立の 1、あれば `1 + 0.1 * 一致数` とし、
 *   タグが一致しないことで total を 0 に落とさない（タグは加点要素であり除外条件では
 *   ない、という recall.md §2 の位置づけ——段1のフィルタではなく段2の再スコアである
 *   ことに合わせた）。
 * - `similarity` は ANN 経由でない候補では存在しないため、中立の 1 として扱う。
 */
export interface ScoringInput {
  now: Date;
  /** ANN 経由の場合のみ渡す。0〜1 の類似度（距離から変換済み）。 */
  similarity?: number;
  tags: string[];
  queryTags: string[];
  occurredAt?: Date | null;
  recordedAt: Date;
  lastReinforcedAt?: Date | null;
  strength: number;
  halfLifeHours: number;
}

export type ScoringStrategy = (input: ScoringInput) => ScoreBreakdown;

/**
 * `freshness` の上限（[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md)）。
 *
 * **🔴 これは「まだ起きていない出来事は、最も古びていない」と決めたものである。**
 * 式の副作用として 1 になるのではなく、選んだ結果として 1 になる。
 *
 * `freshness` の起点は `occurredAt ?? recordedAt` であり、`occurredAt` は
 * docs/memory-model.md §3 の定義（「その出来事・事実がいつのものか」）上、**ふつうに未来になる**
 * （「来月、京都へ出張する」）。減衰式 `0.5 ** (elapsedHours / halfLifeHours)` は
 * 経過時間が負のとき 1 を超え、**上限を持たない**——実測で +30日 → 2.0、
 * +365日 → 4,597、+10年 → 4.2×10³⁶ になる。**上限が無いと、未来の日付を1つ持つ記憶が
 * そのテナントの想起を永久に支配する。**
 *
 * **⚠ これは「未来の出来事を優遇する」決定ではない。**`freshness` は**古び**を測る項なので、
 * まだ起きていない出来事は古びようがない——**「たったいま起きたこと」と同じ扱いにするだけ**である。
 *
 * **⚠ 上限を掛けるのは `freshness` だけで、`decay` には掛けない。**
 * `decay` の起点は `lastReinforcedAt ?? recordedAt` であり、どちらも「mnemora が知った時刻」
 * 系である。そして `defaultDecayStrategy` に手を入れると
 * [ADR 0010](../../../../docs/decisions/0010-decay-parameters.md) が価値を置いている
 * 「`floorAt` が `strengthAt(now) = threshold` の解析解として導かれ、両者が同じ式から
 * 機械的に一貫する」という性質が壊れる。**戦略の側で頭打ちにし、減衰関数そのものは変えない。**
 */
export const MAX_FRESHNESS = 1;

function computeTagMatch(tags: string[], queryTags: string[]): number {
  const tagSet = new Set(tags);
  const matchedCount = queryTags.filter((tag) => tagSet.has(tag)).length;
  return 1 + matchedCount * 0.1;
}

export const defaultScoringStrategy: ScoringStrategy = (input) => {
  const decay = defaultDecayStrategy.strengthAt(input.now, {
    recordedAt: input.recordedAt,
    lastReinforcedAt: input.lastReinforcedAt,
    strength: 1,
    halfLifeHours: input.halfLifeHours,
  });

  const freshness = Math.min(
    MAX_FRESHNESS,
    defaultDecayStrategy.strengthAt(input.now, {
      recordedAt: input.occurredAt ?? input.recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: input.halfLifeHours,
    }),
  );

  const tagMatch = computeTagMatch(input.tags, input.queryTags);
  const similarity = input.similarity;
  const total = (similarity ?? 1) * decay * tagMatch * freshness * input.strength;

  const score: ScoreBreakdown = {
    decay,
    tagMatch,
    freshness,
    strength: input.strength,
    total,
  };
  if (similarity !== undefined) {
    score.similarity = similarity;
  }
  return score;
};
