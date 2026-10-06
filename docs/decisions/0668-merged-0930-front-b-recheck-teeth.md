# ADR 0668: 09/30 にマージされた PR の前半（B 群）の確かめ直しで見つかった穴に歯を足す（Issue #1734）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734)（2026-09-30 マージ分の確かめ直し。PR ごとの結果はそのコメント）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）は触らない（ADR 0667（A 群。PR #1787） などの試験だけの PR と同じ）。

## 経緯

Issue #1734 の B 群のうち、結果がもうコメントされている9本（#1460・#1461・#1463・#1467・#1470・#1475・#1493・#1504・#1509）に、変異試験で「すり抜けた」と報告された変異が**29本**ある（#1460 が1、#1461 が6、#1463 が6、#1467 が2、#1470 が1、#1475 が1、#1493 が3、#1504 が3、#1509 が6）。#1458 は A 群（ADR 0667）の受け持ちなので含めない。

報告は main `ba05ef41`〜`ebce65ae` で測られている。そこで、**すり抜けた変異を main `d645a1f6` でもう一度当てた**。手順は、変異ごとに `cp` で控えを取り、1度に1つ当て、core の全スイート（300本超のファイル・4500件超。新しく足した歯のファイルは除く）を走らせ、`cp` で戻して `cmp` で一致を確かめた。全スイートは変異なしで緑（4515件）だった。
- 全スイートが赤になった変異は「main の歯で塞がっている」とし、歯を足さない。
- 緑のままの変異には歯を足し、歯を入れた状態で「変異で赤・戻して緑」を実測した。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は core の `__tests__` に新しいファイルとして置く。
2. 29本のうち**24本に歯を足す**。**2本（#1493 B2・B8）は、いまの main の歯で既に赤**なので足さない。**1本は約束の外、2本は同値**で歯にしない。
3. #1475 は、約束を ADR 0363 の追記（0363:267-）とし、狭まった部分（params 以降を落とす・4096字で切る）も約束の内として扱う（クローンの決定）。A13（この経路だけ上限を8192字にする）はこの約束の内。#1493 B8 は ADR 0544 が広げた範囲を、いまの約束として当てた。後の ADR で撤回・逆になった約束には、この29本のうち当たるものは見つからなかった。

## すり抜け1本ごとの扱い【実測】

赤の数は、その変異を当てたときに赤になった `it` の数。

| PR | 変異（報告の記号） | 扱い | 歯／塞いでいる main の歯 | 変異での赤の形 |
| --- | --- | --- | --- | --- |
| #1460 | `observationSpeaker` の `typeof === "string"` を外す | 歯 | `extraction-speaker-non-string.test.ts` | 4（数値・オブジェクト・配列・真偽値。`null` は変異が通さないので緑のまま） |
| #1461 | ラテン割合 0.9 の条件を外す | 歯 | `language-mismatch-conditions.test.ts` | 2（約 0.89・0.8） |
| #1461 | コード片の印からパスを外す | 歯 | 同上 | 3（3種のパス） |
| #1461 | コード片の印から `{}<>\|\` を外す | 歯 | 同上 | 6（1文字ずつ） |
| #1461 | share の丸めを外す | 歯 | 同上 | 1（0.95238… が 0.95 でない） |
| #1461 | 検査の対象を digest に替える | 歯 | 同上 | 2（content 英語・digest 日本語と、その逆） |
| #1461 | フォールバックを除く条件を外す | 同値 | 報告が「フォールバックの content は観測の本文そのもので、条件2で必ず null」とした【受】。厳密な証明は無い | — |
| #1463 | E4 embed の次元検査を `>` にする | 歯 | `embed-job-vector-shape-positions.test.ts`（次元4。短い・空・長い） | 2（短い・空） |
| #1463 | E9 embed の有限性の走査が先頭を飛ばす | 歯 | 同上（先頭・中間・末尾） | 1（先頭。位置を保ったまま `i > 0` で飛ばす形で測定） |
| #1463 | R4 recall の次元検査を `>` にする | 歯 | `recall-query-embedding-shape-positions.test.ts` | 2（短い・空） |
| #1463 | R6 recall の有限性の走査が末尾を飛ばす | 歯 | 同上 | 1（末尾） |
| #1463 | R8 recall で provider のゼロベクトルを unavailable にする | 約束の外 | ADR 0393 C8 の読み（ゼロベクトルを弾かない）は報告者の推測【受】。約束として確定していないので縛らない | — |
| #1463 | P2 `toComparableQuery` の有限性の差し替えを外す | 同値 | `fitsFloat4` が非有限を既に弾く【受】 | — |
| #1467 | R1 `related` の並べ替えだけを外す | 歯 | `recall-relation-explore-order-at-limit.test.ts` | 2（`listRelated`・`listRelatedMany` が id の降順で返す store で、安全弁で打ち切るとき残る同伴が変わる） |
| #1467 | W4 `get` が両方 `null` でも救済する | 歯 | `resolve-contested-winner-rescue-both-null.test.ts` | 1（群）。同じ形の2者版 `resolveContested` にも同じ変異で赤1（報告外の補足） |
| #1470 | M11 省略時の群の上限に `association.maxCount` を使う | 歯 | `recall-relation-max-count-independent-of-association.test.ts` | 2（`association.maxCount` が 3・30） |
| #1475 | A13 この経路だけ上限を8192字にする | 歯 | `purge-embedding-cleanup-error-length-cap.test.ts` | 2（4097字・5000字。4096字ちょうどは緑のまま） |
| #1493 | B2 見直す id を先頭の1件だけにする | **main** | `wait-state-change-skipped.test.ts` | 2 |
| #1493 | B7 口なしのループで2件目の打ち切りが書いた分を隠す | 歯 | `reextract-loop-abort-keeps-written-ids.test.ts` | 1 |
| #1493 | B8 見直しを `forgotten` だけに戻す | **main** | `wait-state-change-skipped.test.ts` | 6 |
| #1504 | C4 ラベルの64文字の切り詰めを外す | 歯 | `recall-query-embedding-failure-cause-labels.test.ts` | 2（`errorName` 側・`providerErrorKind` 側を別々に外して各2） |
| #1504 | C7 `Error` でない値の `name` を `errorName` に載せる | 歯 | 同上 | 2 |
| #1504 | C8 `providerErrorKind` を `Error` のときだけにする | 歯 | 同上 | 2 |
| #1509 | R1 未対応 kind のジョブの `fail()` のリース競合の枝 | 歯 | `foreign-realm-store-errors-remaining-sites.test.ts` | 2（別 realm の例外の2脚で各1。判定を常に偽にして測定） |
| #1509 | R3 ハンドラ失敗後の `fail()` のリース競合の枝 | 歯 | 同上 | 2（`instanceof` に戻す形で測定。`false &&` の形は main の `fake-tick-mixed-kinds-concurrency-lease-parity.test.ts` が1本赤にしたが、`instanceof` の形では全スイートが緑） |
| #1509 | I2 `purge` の `MemoryPurgeConflictError` | 歯 | 同上 | 2（`instanceof` に戻す） |
| #1509 | I3 `resolveContestedGroup` の `ContestedGroupMembershipMismatchError` | 歯 | 同上 | 2 |
| #1509 | I4 `reextract` の `SourceMemoryForgottenError` | 歯 | 同上（口あり） | 2。口なしのループにも同じ形があり、同じ表で2赤（報告外の補足） |
| #1509 | I5 `classifySupersedeFailure` の `MemoryStatusConflictError` | 歯 | 同上 | 2 |

**戻して緑**【実測】: 歯を足した24本すべてで、`cp` で戻して `cmp` で一致を確かめたあと、同じ歯が緑に戻った。変異を当てた時点で、core の全スイートの既存の歯（足した歯を除く）は、塞がっていると記録した変異（B2・B8）以外すべて緑だった。

**測り方の補足**【実測】:
- E9 と A13 は、最初の変異の入れ方が荒く（E9 は `slice(1)` で位置がずれ、A13 は整形ごと書き換えた）、既存の歯が別の理由で赤になった。報告の意図に忠実な形（E9 は元の位置で先頭だけ飛ばす、A13 は上限だけ8192字にずらす）に入れ直したところ、全スイートが緑だったので、歯を足した。
- R1 は、`false &&` の形では全スイートが緑だった。R3 は `false &&` の形で main の1本が赤になったので `instanceof` の形に入れ直した（上の表）。
- main は、この作業の途中で #1795 などが入って動いている。変異の再測定は `d645a1f6` の上で行い、歯の緑はその後に main を取り込んだ状態で確かめた。

## 歯にしなかったもの

- **#1461 の「フォールバックを除く条件を外す」・#1463 P2**: 同値（観測できる違いが無い）。報告も振る舞いの変わらない変異としている【受】。
- **#1463 R8**: 約束の外（約束の根拠が報告者の推測）。
- **#1493 B2・B8**: いまの main の歯（`wait-state-change-skipped.test.ts`）で赤になる。
- **#1470 の逆向き**（`relationMaxCount` を指定しても連想枠の件数が変わらない）: 報告のすり抜けは省略時の側だけで、報告外。縛っていない。
- **#1509 の残りの11か所**（`forget`・`markContested`・`resolveContested` ほか）: 報告が「当てていない」とした箇所で、この作業でも探していない。

## 引き受けた負債

- #1509 の歯は core の Fake に別 realm の例外を投げさせる形で、実 DB（Postgres）の経路では測っていない。
- #1467 R1 の歯は、安全弁（訪れた数の上限）で打ち切る小さな群を作る形で、`companionOf` そのものは縛らない（元の報告のとおり、`companionOf` は並べ替えだけでは変わらない）。
- 歯は変異の入れ方（上の表）に対して噛むことを測ったもので、同じ意味の別の壊し方すべてを塞ぐとは言わない。

## 確かめていないこと

- 約束が後の ADR で変わっていないことは、報告者の照合に加え、いまのコードの TSDoc で確かめた。ADR の本文は全部読み直していない。
- Postgres の歯は足していない（報告のすり抜けが core の Fake で再現できる形だったため）。
- 報告に無い変異は探していない。
- ⛔ 2026-09-20〜09-26 にマージされた PR の確かめ直しは別の担当の受け持ちで、触っていない。
