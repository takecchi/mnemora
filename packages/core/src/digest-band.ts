import type { DigestBandLimitedBy, DigestEntry } from "./recall.js";
import { sliceAtGraphemeBoundary } from "./text-truncation.js";

/**
 * `packDigestBand` — 目次帯（`IndexBand.digestBand`）を組む純関数（docs/recall.md §5）。
 * 候補の並べ替えはしない（呼び出し側が決めた順序をそのまま使う）。
 */
export interface PackDigestBandOptions {
  /** 帯に載せる件数の上限。`NaN` は打ち切り側（負数と同じ）、`+Infinity` は上限なしとして扱う。 */
  limit: number;
  /** 帯全体の文字数予算。`NaN` は打ち切り側（負数と同じ）、`+Infinity` は上限なしとして扱う。 */
  maxChars: number;
  /**
   * 1件の digest の文字数上限。超えたら切り詰めて `truncated: true` を立てる。
   * `NaN` と負数は打ち切り側（上限0＝digest を空に切る）、`+Infinity` は上限なしとして扱う。
   */
  maxEntryChars: number;
}

/** `packDigestBand` の戻り値。 */
export interface PackedDigestBand {
  /** 帯に載せた digest（呼び出し側が決めた順のまま）。 */
  band: DigestEntry[];
  /** どの上限で打ち切ったか。どの上限にも当たらなかったら省く。 */
  limitedBy?: DigestBandLimitedBy;
}

/**
 * 1件を帯へ積んだときの JSON 上の費用の見積もり（固定部分）。
 * `{"memoryId":"<36字uuid>","digest":"..."}` から digest の中身を除いた記号類と UUID の実測値。
 */
export const DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS = 63;

/** 配列の中でこの件を区切るカンマ1字分（`DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS` に加算する）。 */
export const DIGEST_BAND_ENTRY_SEPARATOR_CHARS = 1;

/**
 * `candidates` から目次帯を組む。
 *
 * @param candidates 帯に載せる資格がある候補。呼び出し側が決めた順序をそのまま使う。
 * @param eligible 資格があった総数（`ScopeAggregate.digestEligible.count`）。呼び出し側が既に
 *   `limit` で切って渡すことがあるので `candidates.length` とは限らない。
 * @param opts 上限3種（`PackDigestBandOptions`）。
 *
 * **呼び出し側の義務: `candidates.length <= eligible` で渡すこと。** この関数は `eligible` で打ち切らない。
 * 破られるのは `MemoryStore` が契約（`digests` は `digestEligible.count` を超えない）を破ったときだけで、
 * 握り潰さず契約側（`packages/testkit` の適合テスト）で捕まえる。
 * この関数自身が保証するのは `band.length <= candidates.length` まで。
 *
 * **`limitedBy`**:
 * - 件数の上限（`limit`）で打ち切った ⟹ `"entry_limit"`。
 * - 文字数の予算（`maxChars`）で打ち切った ⟹ `"char_budget"`。
 * - 同じ件で両方に当たった ⟹ `"both"`。
 * - 打ち切りが起きず `candidates` を全部載せ、かつ `band.length >= eligible` なら省略する。
 * - `eligible > band.length` なのに省略される状態は作らない（`candidates` が既に `limit` 件で切られて
 *   渡ってきた場合も `"entry_limit"`）。
 */
export function packDigestBand(
  candidates: readonly DigestEntry[],
  eligible: number,
  opts: PackDigestBandOptions,
): PackedDigestBand {
  const band: DigestEntry[] = [];
  let runningChars = 0;
  let limitedBy: DigestBandLimitedBy | undefined;

  for (const candidate of candidates) {
    // NaN は上限0（digest を空に切る）として扱う。`length > NaN` は常に false で「切り詰めなし」へ化ける。
    const entryCharsIsNaN = Number.isNaN(opts.maxEntryChars);
    const digestTooLong = entryCharsIsNaN || candidate.digest.length > opts.maxEntryChars;
    // 負数は上限0として扱う（`slice(0, 負)` は末尾から除く意味になる）。
    const digest = digestTooLong
      ? // `sliceAtGraphemeBoundary` は NaN を 0 へ丸めない（`Math.max(0, NaN)` は NaN）ので、
        // NaN はここで 0 を明示して渡す。
        sliceAtGraphemeBoundary(candidate.digest, entryCharsIsNaN ? 0 : opts.maxEntryChars)
      : candidate.digest;
    const cost =
      DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS + digest.length + DIGEST_BAND_ENTRY_SEPARATOR_CHARS;

    // NaN を含む比較は常に false で、上限が無制限へ化ける。NaN は既に上限に達している扱いに倒す。
    // `±Infinity` は通常の比較で意図どおり。
    const wouldExceedLimit = Number.isNaN(opts.limit) || band.length >= opts.limit;
    const wouldExceedChars = Number.isNaN(opts.maxChars) || runningChars + cost > opts.maxChars;

    if (wouldExceedLimit && wouldExceedChars) {
      limitedBy = "both";
      break;
    }
    if (wouldExceedLimit) {
      limitedBy = "entry_limit";
      break;
    }
    if (wouldExceedChars) {
      limitedBy = "char_budget";
      break;
    }

    const entry: DigestEntry = { memoryId: candidate.memoryId, digest };
    if (digestTooLong) {
      entry.truncated = true;
    }
    band.push(entry);
    runningChars += cost;
  }

  if (limitedBy === undefined && band.length < eligible) {
    // 資格件数に届かない＝`candidates` が既に `limit` 相当で切られて渡ってきた。entry_limit として報告する。
    limitedBy = "entry_limit";
  }

  return limitedBy === undefined ? { band } : { band, limitedBy };
}
