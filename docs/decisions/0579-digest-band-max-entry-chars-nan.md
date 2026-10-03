# ADR 0579: `packDigestBand` の `maxEntryChars: NaN` を、負数と同じ「digest を空に切る」へ倒す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 問題

`packDigestBand`（`packages/core/src/digest-band.ts`）は、`maxEntryChars` を `candidate.digest.length > opts.maxEntryChars` で判定していた。`NaN` との比較は常に false なので、`maxEntryChars: NaN` は「切り詰めなし」（無制限）へ化けていた。【現物】

## 決定

`maxEntryChars` の `NaN` は、負数と同じ安全側に倒す。全エントリの `digest` を `""` にし、`truncated: true` を立てる。`+Infinity` は今までどおり上限なし。`RangeError` は投げない。

`sliceAtGraphemeBoundary` は `Math.max(0, NaN)` が `NaN` のままで、`NaN` を 0 へ丸めない。そのため `packDigestBand` 側で、`NaN` のときは 0 を明示して渡す（`text-truncation.ts` は変えない）。【現物】

## 根拠（先例）

- **同じ関数の `limit`・`maxChars`**: `NaN` は負数と同じ打ち切り側に倒す（Issue #803）。`maxEntryChars` だけが逆（無制限）だった。【現物】
- **`truncateForFallbackDigest`（ADR 0467）**: 非有限の入力を安全側に倒す。【現物】
- **負数の `maxEntryChars`**: すでに `digest` を `""`・`truncated: true` に切る（`__tests__/digest-band.test.ts` の負数の歯）。`NaN` はそれに揃える。【現物】

## なぜ `RangeError` にしないか

同じ関数の他の2つの上限は、`NaN` でも投げない。`maxEntryChars` だけ投げると、同じオプションの束の中で扱いが割れる。新しい例外は呼び出し側の契約を変える。【判断】

## 赤から緑

`digest-band.test.ts` に `maxEntryChars: NaN` の歯（`digest` が `""`・`truncated: true`、結果全体が負数のときと一致）を足した。【実測】修正前は `digest` が `"0123456789"` のまま・`truncated` なしで失敗し、修正後に通る。

## 影響

`packDigestBand` を直接呼んで `NaN` を渡していた呼び出し側だけが変わる。`recall()` が渡すのは定数 `DIGEST_BAND_MAX_ENTRY_CHARS` なので、`recall()` の振る舞いは変わらない。【現物】
