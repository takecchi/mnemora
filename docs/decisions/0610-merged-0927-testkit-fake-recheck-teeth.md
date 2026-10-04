# ADR 0610: 09/27 にマージされた testkit・Fake の PR の確かめ直しで見つかった穴に歯を足す（#1280・#1250・#1243・#1231・#1170・#1135・#1120・#1183・#1114・#1095・#1157・#1146・#1073）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1725](https://github.com/takecchi/mnemora/issues/1725) で、そこに確かめ直しの記録（約束・変異・すり抜け）が1本ずつ残っている。歯を足すと決めたことと範囲（下の「案A」）も、クローンが決めた。
クローンのマネージャー（mgr-78d4264a）の依頼で、担い手が歯を書いた。出所の区別: 【現物】は読んだコード・PR 本文、【実測】は手元で走らせた結果、【判断】はマネージャーか担い手の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）には触れない（[ADR 0608](./0608-merged-0928-recheck-teeth-a.md)・[ADR 0611](./0611-merged-0928-recheck-teeth-b.md) と同じ形）。

## 経緯

09/27（UTC）にマージされた testkit・Fake の PR を、約束ごとに足りない側とやりすぎ側の変異を入れて確かめ直した【実測】。前半の8本は前の担当（mgr-955ee40f）が、残りの12本はこの担当が受け持った。結果は #1725 にある。

約束は、各 PR の本文（マネージャーが `gh pr view` で読み、担い手の約束の表と照らした）、TSDoc・コード、後の ADR から取った【現物】。後の ADR で約束が変わっていたときは、#1725 の最初のコメントにある決まりに従った。広がっただけなら今の当て先に当て、撤回・逆になった約束には当てない。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は DB を使わない `__tests__`（testkit と core）に置く。
2. 歯を足すのは、#1725 のすり抜けのうち、次の3つをすべて満たすもの（#1725 の「案A」）。
   - どの歯（PR の歯・差分の歯・適合テスト）にも捕まらない。
   - 約束が PR 本文・TSDoc に書かれている。
   - 今の実装のまま緑になる。
3. 歯ごとに、今の main で緑になること、狙う変異で赤になること、戻すと緑になることを実測した。

| 出所の PR | 約束（PR 本文・TSDoc） | 足した歯 | 赤にした変異 |
| --- | --- | --- | --- |
| #1280 | createRecall は jsonb の7列の NUL を拒み、記録も時計も進めない／claimBatch は claim する行が無くても NUL を拒む | omitted・usage・indexBand・returnedMemories の4行、各場合の末尾で記録が増えていないこと、ジョブの無い store の claimBatch | 4列を検査から外す、検査を記録の書き込みの後ろへ動かす、ジョブが在るときだけ検査する |
| #1250 | decayBaseSeq・decayFloorSeq は 2^63 以上を拒む／halfLifeRecalls は (0, ∞) を受け付ける | decayFloorSeq が 2^63、halfLifeRecalls の 0.5・1e-30 | decayFloorSeq だけ 2^63 以上を通す、(0, 1) を拒む |
| #1243 | 拒むのは Invalid Date だけ | 4つの日時の欄に 1969-12-31 を渡して通り、同じ値で読み戻る | 1970 年より前を拒む |
| #1231 | 途中で投げたら、作ったラベルも取り消す | 失敗の後に、ラベルの紐付けの件数が呼ぶ前と同じ | 巻き戻しからラベルの紐付けを外す |
| #1170 | 6つの口で不正な kind を拒み、何も書かない。検査は既存の検査の後 | purgeMemory・resolveContestedPair・resolveOrphanedContested・supersede の4つの口、markContestedPair の1件目、見つからない id・CAS の食い違いが先に決まること（supersede を除く5つの口） | 検査を外す、CAS・見つからない id より前へ動かす |
| #1135 | core の Fake もラベルのキーを組にした（PR 本文） | core の Fake で、registerLabel が別のテナントの行を書き換えない、前方一致で別のテナントのラベルが出ない | registerLabel だけ衝突する形で引く、listLabels を前方一致にする |
| #1120 | claimBatch の now は複製して保存する | 取り直しのときに availableAt へ入る now | 取り直しの複製を外す |
| #1183 | 位置は見つからない id・CAS の後／supersede の新しい行も検査する／値の集合は core のスキーマから取る | updateStatusWithEvent の順、supersede の news の列挙の外、列ごとに全部の値が通り、外の値が拒まれる | 検査を前へ動かす、supersede の news で素通りさせる、`"purged"` を通す |
| #1114 | Memory を返す口は複製を返す | WithOutbox の冪等の再送、setEmbeddingStatus と reinforce の何もしない分岐、17口の外の4つの口（listBySourceObservationAllVersions・findContestedByClaimKey・markContestedGroup・resolveContestedGroup） | 各分岐・各口の複製を外す |
| #1095 | 境界は `Math.fround(x)` が 0 になるかとビット単位で一致する／WithOutbox も同じ入口で拒む | 境界の両側（7.0e-46 は拒み、7.1e-46 は通す。testkit・core）、core の WithOutbox | 境界を `< 1e-45` にずらす、WithOutbox の入力を差し替える |
| #1157 | 検査の順は「非整数 → 負数 → bigint の範囲」／2^53・2^63 − 1024 は通る | −1.5・−Infinity が整数の文面で拒まれる（testkit・core）、testkit の 2^53、core の 2^63 − 1024 | 順を入れ替える、2^53 を拒む、範囲を 2^62 に狭める |
| #1146 | 空間の3欄（provider・model・dimensions）を完全一致で比べる | dimensions だけ違う空間、provider だけ違う空間（testkit・core） | 比較から dimensions・provider を外す |
| #1073 | jsonb の判定は `JSON.stringify` の結果を辿る（toJSON も同じ形）／両方の Fake で、冪等の判定より前に見る | toJSON が NUL を返す値は拒み、toJSON が消すなら通す（testkit・core）、core の同じ externalId の再送 | 元の値を辿る、core の検査を冪等の判定の後ろへ動かす |

#1183 の「列ごとに全部の値」の歯は、fixture の中のモジュール `memory-enum-check.ts` の関数を直接呼ぶ。公開の口から全部の値を通すと、列の組み合わせの検査（status と参照の組など）に先に当たるためである【判断】。

## 外したもの・縛っていないもの

- **#1231 の冪等キーの索引**: #1725 では「巻き戻しから索引を外すとすり抜ける」と書いた。しかし、残った索引は消えた Memory の id を指すだけで、`createMemoryIdempotent` は行が無ければ新しく作る。振る舞いの変わらない変異だった【実測。歯を書いて、変異で赤にならないことを確かめた】。歯は足さない。
- **#1170 の supersede の「不正な kind と見つからない id」の順**: InMemory はイベントの検査を先に置く。これは [ADR 0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md) が書いている以前からの差なので、順の歯は supersede 以外の5つの口に限った【現物】。
- #1725 の「案B」（ほかの歯が既に捕まえているもの・約束が弱いもの）と、provider の3本（#1223・#1147・#1083）は、この PR に入れない。provider の分は別の試験だけの PR にする【判断】。
- 試験だけでは塞げない次の3件は、別の Issue に記録する。
  - 実装：#1120 の createRecall の `createdAt` と purgeMemory の `purgedAt` が、呼び手の Date を共有する。
  - 実装：#1265 の archiveDecayed は、wall のとき `nowSeq: 1.5` を fixture だけが拒む【実測】。
  - 文書：`packages/postgres/README.md` の「例外の見分け方」が古い。
- core の Fake は、関数を持つ payload を `structuredClone` で落とす（DataCloneError）。そのため #1073 の「toJSON が消すなら通す」の core の歯は、列挙されない `toJSON` で書いた【実測】。この差そのものは縛らない。

## これが覆るとしたら

上の表の約束が、後の ADR で狭まるか意味が変わるとき。歯はその約束を名指ししているので、そのときは歯の側も直す。
