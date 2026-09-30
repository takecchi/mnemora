/**
 * LLM が返した抽出候補の補助の欄（`digest`・`tags` の要素・claim key の `subject`/`predicate`）のうち、
 * **保存できない値**だけを落とす（内部の関数。`index.ts` からは出さない。ADR 0443）。
 *
 * 「保存できない」とは、どの adapter も拒む値——**NUL（U+0000）を含む文字列**——のことである。
 * `@mnemora/postgres` は text に NUL を入れられず、testkit の fixture も `digest`・`tags` の NUL を拒む。
 * 補助の欄に1つ入っているだけで、本文が正しくても `createMemoryWithOutbox` が拒み、候補ごと落ちていた
 * （ADR 0347 の「保存できない候補」の経路）。本文（`content`）の NUL はここでは扱わない（本文は落とせない。
 * 従来どおり候補ごと落ちる）。
 *
 * もう1つ、**`tags` の要素の巨大さ**も見る。Postgres の GIN 索引（`idx_memories_tags`）は1要素が約 2.7KB
 * （圧縮したあと）を超えると INSERT を拒む。上限は {@link MAX_TAG_CODE_POINTS} コードポイント（UTF-8 で最大
 * 4 バイト × 512 = 2048 バイトで、圧縮が効かなくても届かない）。⚠ 圧縮が効く値（繰り返しなど）は
 * 上限超えでも保存できていたが、値で分けると判定が adapter 依存になるので、長さだけで落とす（ADR 0443 決定2）。
 * `digest` の長さは見ない（索引が無く、手元の Postgres で巨大な値も保存できた）。
 */
import type { ExtractedMemoryCandidate } from "./extraction.js";

/**
 * 保存できないために落とした補助の欄1つの記録。`created` イベントの `meta.droppedFields` に入る
 * （公開の型ではない。`meta` は自由形式の欄である）。`droppedCandidates` と同じく、候補は `index`
 * （LLM が返した順の 0 起点）と `contentHash` で指し、**値そのものは写さない**。
 */
export interface DroppedAuxField {
  /** 候補の `index`（`droppedCandidates[].index` と同じ数え方）。 */
  index: number;
  /** 候補の本文の `contentHash`（`droppedCandidates[].contentHash` と同じ）。 */
  contentHash: string;
  /** 落とした欄。`digest` はフォールバックの digest に、`claimKey` は `null` に、`tags` は該当の要素だけを捨てた。 */
  field: "digest" | "tags" | "claimKey";
  /** 落とした理由。`nul_character` は NUL を含む、`too_long` は `tags` の要素が {@link MAX_TAG_CODE_POINTS} を超える。 */
  reason: "nul_character" | "too_long";
  /** `tags` のときだけ: 捨てた要素の数。 */
  count?: number;
  /** `tags` のときだけ: 捨てた要素の、LLM が返した `tags` の中の添字（先頭から {@link DROPPED_TAG_INDEXES_MAX} 個まで）。 */
  tagIndexes?: number[];
}

/** `DroppedAuxField.tagIndexes` に載せる添字の数の上限（tag が何万件も NUL でも meta を膨らませない）。 */
export const DROPPED_TAG_INDEXES_MAX = 20;

/** `tags` の1要素の長さの上限（コードポイント）。GIN 索引の1エントリの上限（約 2.7KB）に、最悪の4バイト文字でも届かない値。 */
export const MAX_TAG_CODE_POINTS = 512;

/** 文字列が {@link MAX_TAG_CODE_POINTS} を超えるか。 */
export function exceedsTagLimit(value: string): boolean {
  // UTF-16 の単位数はコードポイント数以上なので、これ以下なら数えるまでもなく上限内
  if (value.length <= MAX_TAG_CODE_POINTS) {
    return false;
  }
  return Array.from(value).length > MAX_TAG_CODE_POINTS;
}

/** 文字列が NUL（U+0000）を含むか。 */
export function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

/** {@link sanitizeCandidateAuxFields} の戻り値（`index`・`contentHash` を持たない下書き）。 */
export interface SanitizedCandidateAuxFields {
  /** 保存できない補助の欄を落とした候補。落とす欄が無ければ、渡した候補そのもの。 */
  candidate: ExtractedMemoryCandidate;
  /** 落とした欄（`index`・`contentHash` は呼び出し側が足す）。 */
  dropped: Array<Pick<DroppedAuxField, "field" | "reason" | "count" | "tagIndexes">>;
}

/**
 * 候補の `digest` と `tags` から、保存できないものを落とす。
 *
 * - `digest` が NUL を含めば、`digest` を無い（`undefined`）ことにする——あとの `resolveDigest` が、空・欠落と同じく
 *   本文の先頭を切り出したフォールバックへ倒す。
 * - `tags` は NUL を含む要素、{@link MAX_TAG_CODE_POINTS} を超える要素だけを捨てる。ほかの要素の並び・重複・前後の空白はそのまま残す。
 *
 * 空白だけの要素は、ここでは扱わない（従来どおり `dropBlankTags` が捨てる）。
 */
export function sanitizeCandidateAuxFields(
  candidate: ExtractedMemoryCandidate,
): SanitizedCandidateAuxFields {
  const dropped: SanitizedCandidateAuxFields["dropped"] = [];
  let next = candidate;
  if (candidate.digest !== undefined && containsNul(candidate.digest)) {
    const { digest: _digest, ...rest } = next;
    next = rest;
    dropped.push({ field: "digest", reason: "nul_character" });
  }
  const tags = candidate.tags;
  if (tags !== undefined) {
    const nul = { indexes: [] as number[], count: 0 };
    const long = { indexes: [] as number[], count: 0 };
    const kept: string[] = [];
    tags.forEach((tag, tagIndex) => {
      const bucket = containsNul(tag) ? nul : exceedsTagLimit(tag) ? long : undefined;
      if (bucket === undefined) {
        kept.push(tag);
        return;
      }
      bucket.count += 1;
      if (bucket.indexes.length < DROPPED_TAG_INDEXES_MAX) {
        bucket.indexes.push(tagIndex);
      }
    });
    if (nul.count + long.count > 0) {
      next = { ...next, tags: kept };
      if (nul.count > 0) {
        dropped.push({
          field: "tags",
          reason: "nul_character",
          count: nul.count,
          tagIndexes: nul.indexes,
        });
      }
      if (long.count > 0) {
        dropped.push({
          field: "tags",
          reason: "too_long",
          count: long.count,
          tagIndexes: long.indexes,
        });
      }
    }
  }
  return { candidate: next, dropped };
}
