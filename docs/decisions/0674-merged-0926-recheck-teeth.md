# ADR 0674: 09/26 にマージされた PR の確かめ直しで見つかった穴に歯を足す（Issue #1774）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1774](https://github.com/takecchi/mnemora/issues/1774)。
これは試験だけの変更で、実装（`src` の非テストのファイル）は触らない。公開の適合テスト（`*-conformance.ts`）も触らない。

## 経緯【実測】

2026-09-26（UTC）にマージされた PR は135本。`src` の非テストのファイルを触るものは88本で、doc コメントだけ・試験だけ・測定の道具の26本を外した **62本**（A 群30本：postgres・bullmq・local-embedding・examples/chat を含む、B 群32本：core・testkit だけ）を対象にした。分母と外した理由は #1774 の本文にある。

担当は mgr-0495eb46 が始め、2026-10-06T15:08Z の器の入れ替わりのあとを mgr-1b13db06 が引き継いだ。前任の未 push の歯は退避 ref（`refs/alteroid-rescue/mgr-0495eb46-…`）から拾い直した（#986 の (e)）。退避 ref に入っていた変異の取り残し（`tick-driver.ts`・Fake の `fakeLexicalTokenize`・`recall-runtime.ts`）は持ち込んでいない。

PR ごとに、PR 本文・差分・関連 ADR から約束を列挙し、**足りない側の変異と、やりすぎた実装の変異を両方**当てた。約束が後の ADR・PR で変わっていたものは、いまの約束に当てた（例：#858 は ADR 0424・0467・0470、#928 は ADR 0493・0543・0563、#986 は ADR 0381・0494、#932 は ADR 0362・0374・0443）。変異は控えを `cp` で取ってから当て、`cp` で戻して `cmp` で一致を確かめた。PR ごとの約束・変異の表・すり抜け・足した歯・塞がない理由は、#1774 の PR ごとのコメントにある。

すり抜けの多かったもの：

- #1052（SQL へ渡す `Date` は `toPgTimestamp` を通す）：書き込み口76か所のうち、既存の歯が見ていたのは9か所だけで、67か所は外しても緑だった。
- #937・#941（`examples/chat` のファクトリの close-on-throw・`closePostgresClient` の冪等）、#928（Fake の NUL 検査）、#1071、#982（ゼロベクトル候補）、#875、#919。

## 決定【判断】

1. 実装は変えない。足すのは、すり抜けた変異のうち約束の内にあるものを塞ぐ歯だけである。歯は store 固有の試験、または core・testkit・examples の個別の試験ファイルに置く。
2. #1052 の歯は `packages/postgres/src/__tests__/conformance.postgres.test.ts`（postgres 固有の実行器。公開の適合テストではない）の末尾に置く。適合テストが一巡する間に発行された全クエリの束縛値に `Date` が無いことを、1本の `it` で見る（`afterAll` で落とす形にせず、ほかの試験を巻き込まない）。そのために、実行器側の `seedJob` が素の `Date` を渡していたのを `toPgTimestamp` で包む。配列・JSON の中の `Date` は `timestamp-write-uncovered-paths.postgres.test.ts` で見る。
3. 次のものは塞がない（理由は #1774 の各コメント）。
   - 等価な変異（例：#986 の M3、#1022 の N1、#1069 の6個は後の ADR 0424 の `fitsFloat4` が同じ検査を持つ）。
   - PR が決めていない挙動（#955 の大文字小文字違いの `HELP`、#967 の登録中の `stop()` での `start()` の決着、#993・#1071 のメッセージや空の omitted の表記）。歯にすると決定を作ることになる。
   - 歯を置けないもの（#937・#941 の `bench/association-scale-*.ts` の `create*`。export されておらず、import すると `main()` が走る）。
4. 確かめ直しで見つけた実装の未達は、実装を直さずに起票する。#1022 の N9（連想の席に着けなかった比較不能の記憶が `over_limit(association)` と `score_not_comparable` の両方に数えられる）は #1788 に起票し、#1791 で直った。この枝では `it.fails` で明示していたが、#1791 が同じ歯を `it` として入れたので、main に合わせるときに外した。

## 確かめていないこと

- `bullmq` の `*.redis.test.ts` は、手元に Redis が無いので走らせていない（#967・#889・#900 のコメントに明記）。
- #1023 の S10（群の上限で切られた候補が `over_limit(association)` とも重なる疑い）は実測していない。ADR 0494 の領分で、#1023 の約束の外とした。
- 対象外の日付の PR で見つけた歯の穴（09/30 の #1479 の `purgeCompletedJobs`・`purgeExpiredRecalls` の 2^63 のガードを外しても緑）は、その担当へ回した。塞いでいない。
- 既に起票済みで、直すのは別の仕事のもの：#1779（死んだコード）、#1780（`extensionSchema` を `public` 以外にすると pgvector の能力検査が落ちる）。
