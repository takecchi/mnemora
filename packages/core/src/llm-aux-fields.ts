/**
 * LLM が返した抽出候補の補助の欄（`digest`・`tags` の要素・claim key の `subject`/`predicate`）のうち、
 * **保存できない値**だけを落とす（内部の関数。`index.ts` からは出さない。ADR 0443）。
 *
 * 「保存できない」とは、どの adapter も拒む **NUL（U+0000）を含む文字列**のこと。補助の欄に1つ入って
 * いるだけで本文が正しくても候補ごと落ちるので、その欄だけ落とす。本文（`content`）の NUL はここでは
 * 扱わない（本文は落とせないので、候補ごと落ちる）。
 *
 * ⚠ **既知の限界: 長い tag は索引の上限で落ちうる。**GIN 索引は、1要素が圧縮したあとでおよそ 2712 バイトを
 * 超えると INSERT を拒む。上限は圧縮後の大きさで決まり、testkit の fixture は通すので、字数では線を引かない。
 * 今保存できている tag を新しく黙って捨てないため、長さの判定は置いていない（ADR 0443 決定1）。
 * 圧縮が効かない長い tag は、例外で候補ごと落ちる。`digest` の長さも見ない（索引が無い）。
 */

/** 補助の欄（`digest`・`tags`）を持つ、LLM が返した値の最小の形。抽出の候補・統合・内省の結果が当てはまる。 */
export interface AuxFieldCarrier {
  digest?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * 保存できないために落とした補助の欄1つの記録。`created` イベントの `meta.droppedFields` に入る。
 * 候補は `index`（LLM が返した順の 0 起点）と `contentHash` で指し、**値そのものは写さない**。
 */
export interface DroppedAuxField {
  /** 候補の `index`（`droppedCandidates[].index` と同じ数え方）。 */
  index: number;
  /** 候補の本文の `contentHash`（`droppedCandidates[].contentHash` と同じ）。 */
  contentHash: string;
  /** 落とした欄。`digest` はフォールバックの digest に、`claimKey` は `null` に、`tags` は該当の要素だけを捨てた。 */
  field: "digest" | "tags" | "claimKey";
  /** 落とした理由。今は NUL だけ。 */
  reason: "nul_character";
  /** `tags` のときだけ: 捨てた要素の数。 */
  count?: number;
  /** `tags` のときだけ: 捨てた要素の、LLM が返した `tags` の中の添字（先頭から {@link DROPPED_TAG_INDEXES_MAX} 個まで）。 */
  tagIndexes?: number[];
}

/** `DroppedAuxField.tagIndexes` に載せる添字の数の上限（tag が何万件も NUL でも meta を膨らませない）。 */
export const DROPPED_TAG_INDEXES_MAX = 20;

/** 文字列が NUL（U+0000）を含むか。 */
export function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

/** {@link sanitizeCandidateAuxFields} の戻り値（`index`・`contentHash` を持たない下書き）。 */
export interface SanitizedCandidateAuxFields<T extends AuxFieldCarrier = AuxFieldCarrier> {
  /** 保存できない補助の欄を落とした候補。落とす欄が無ければ、渡した候補そのもの。 */
  candidate: T;
  /** 落とした欄（`index`・`contentHash` は呼び出し側が足す）。 */
  dropped: Array<Pick<DroppedAuxField, "field" | "reason" | "count" | "tagIndexes">>;
}

/**
 * 候補の `digest` と `tags` から、保存できないものを落とす。
 *
 * - `digest` が NUL を含めば、`digest` を無い（`undefined`）ことにする——あとの `resolveDigest` が、空・欠落と同じく
 *   本文の先頭を切り出したフォールバックへ倒す。
 * - `tags` は NUL を含む要素だけを捨てる。ほかの要素の並び・重複・前後の空白はそのまま残す。
 *
 * 空白だけの要素は、ここでは扱わない（従来どおり `dropBlankTags` が捨てる）。
 */
export function sanitizeCandidateAuxFields<T extends AuxFieldCarrier>(
  candidate: T,
): SanitizedCandidateAuxFields<T> {
  const dropped: SanitizedCandidateAuxFields<T>["dropped"] = [];
  let next = candidate;
  if (candidate.digest !== undefined && containsNul(candidate.digest)) {
    const { digest: _digest, ...rest } = next;
    next = rest as T;
    dropped.push({ field: "digest", reason: "nul_character" });
  }
  const tags = candidate.tags;
  if (tags !== undefined && tags.some(containsNul)) {
    const tagIndexes: number[] = [];
    let count = 0;
    const kept: string[] = [];
    tags.forEach((tag, tagIndex) => {
      if (containsNul(tag)) {
        count += 1;
        if (tagIndexes.length < DROPPED_TAG_INDEXES_MAX) {
          tagIndexes.push(tagIndex);
        }
      } else {
        kept.push(tag);
      }
    });
    next = { ...next, tags: kept };
    dropped.push({ field: "tags", reason: "nul_character", count, tagIndexes });
  }
  return { candidate: next, dropped };
}
