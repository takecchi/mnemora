# ADR 0669: 09/19 にマージされた連想枠の順位キー（#549）と repo/modelId 宣言の検査（#550）の確かめ直しで見つかった穴に歯を足す（Issue #1793）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1793](https://github.com/takecchi/mnemora/issues/1793)。
これは試験だけの変更で、`packages/core/src/recall-runtime.ts` と `packages/local-embedding/src/local-embedding-provider.ts` は触らない。

## 経緯【実測】

対象は 2026-09-19（UTC）にマージされた2本である。

- #549（連想枠＝段3.5 の席を、減衰を含む順位で埋める。[ADR 0246](./0246-association-rank-includes-decay.md)）
- #550（`repo` だけ差し替えて `modelId` を省くとコンストラクタで落とす。[ADR 0247](./0247-local-embedding-repo-model-id-declaration-guard.md)）

残りの5本（#551・#552・#553・#555 は文書だけで機械の約束が無い、#554 は ADR 0293 が撤回済み）は外した。分母は Issue #1793 にある。

main `2761e7ff`（#1791 を含む）で、変異を `cp` で控えを取って1本ずつ当て、赤になること・`cp` で戻して緑になること・`cmp` で控えと一致することを確かめた。#550 の変異は local-embedding の試験ファイル、#549 の変異は `packages/core` の全試験（311 ファイル）で測った。

先の確かめ直し（[ADR 0663](./0663-merged-0923-recheck-teeth.md)・[ADR 0666](./0666-merged-0920-0921-recheck-fingerprint-gate-and-cache-key-teeth.md)）と同じ形がここでも出た。既存の歯は decay だけを動かしていて、順位キーが積であること・decay 以外の3項・席の数え方・同点の並びを縛っていなかった。

**前の測定は #1791 より前のコードで取ったものだった**（作業ツリーに変異が混入した事故のため、clone を取り直して全部測り直した。経緯は Issue #1793 のコメント）。この ADR の数字は、取り直した clone（main `2761e7ff`）のものである。

### #549（連想枠の順位）

歯を足す前に素通りだったもの（`packages/core` の全試験が緑のまま）。

- 順位キー `hit.similarity * score.total` の変形
  - A2: `score.total` だけにする（類似度を外す）
  - A3: `similarity × decay` にする
  - A3b: `similarity × decay × freshness × tagMatch`（strength を外す）
  - A3c: `similarity × decay × strength × tagMatch`（freshness を外す）
  - A3d: `similarity × decay × freshness × strength`（tagMatch を外す）
- A6: 過取得の幅の下限（`Math.max(maxCount, …)`）を外す
- A7: `over_limit(association)` を `max(0, 候補総数 − maxCount)` にする
- A10: `over_limit(association)` を `候補総数 − 席に着いた数` にする
- A12: 順位キーが同点のとき、adapter の順でなく memoryId で並べる

どちらも多層防御が候補を落としたときだけ値が変わる（ADR 0246 決定5）ので、通常の試験では見えない。

等価と判定したもの（歯にしない）:

- A13: 連想の Unit の `rankScore` を `rankKey` から `score.total` へ変える。`rankScore` を読むのは `units.sort`（`recall-runtime.ts` 1870 行）だけで、そこで並べるのは `units`（段2・段3 の本体）だけである。`associationUnits` は `allUnits = [...units, ...associationUnits]`（2462 行）で連結するだけで並べ直さず、`findBudgetCut` も `rankScore` を読まない。
- A14: 連想の候補の `score.total` を `rankKey` で置き換える（`asAssociationMember`、2336 行）。連想の `score` は `similarity`・`lexicalMatch` を渡さないので `affinityMeasured === false` で、返り値へ変換する `toRecalledScore`（218 行）が `total` を落とす（ADR 0352）。`finalMemories` の `score` はそれを通る。ほかに連想の `score.total` を読む所が無い。

### #550（repo/modelId の宣言の検査）

`packages/local-embedding/src` は `6e72696c` から #1791 の時点まで変わっていない（`git diff 6e72696c HEAD -- packages/local-embedding/src` が空）。先の測定（歯を足す前に素通りだった G4b・G5・G9・G11・G6・G10）がそのまま今の main に当たる。

## 決定【判断】

1. 実装は変えない。足すのは試験だけである。
2. `recall-association-usage-ranking.test.ts` に、次の歯を足す。
   - 順位キーが積であること: 近いが decay が少し低いほうが勝つ／近いが decay がずっと低いほうは負ける（類似度だけでも decay だけでも決まらない）
   - strength・freshness・tagMatch の各項が、他を揃えたまま席を決めること（先に作った A が負け、後から作った B が勝つ形。同点なら先が勝つので、同点で偶然通らない）
   - `overFetchFactor < 1` でも `maxCount` 件返ること
   - 順位キーが同点なら adapter が返した順のまま席を埋めること（adapter の順を反転した形も。memoryId で並べ直さない。ADR 0170）
   - 連想用 `search()` が忘却・validAt のゲートを剥がして減衰しきった記憶を混ぜても、その分は `over_limit(association)` に入らないこと（二重計上しない。決定5）
3. `repo-model-id-declaration-guard.test.ts` に、次の歯を足す。
   - 既定と同じ `modelId` を明示した私設ミラーが通ること（ADR 0247 決定3）
   - repo だけ差し替えて他の option（revision・cacheDir・dtype・numThreads・dimensions・prefix・maxBatchSize・retry・createPipeline）を同時に渡しても落ちること
   - `repo: ""` でも落ちること
   - 大文字小文字だけ違う repo も落ちること（文字列そのままの比較）
4. 歯が今の約束より強いことを縛っていないかを見直した。ADR 0246（決定1・3・4・5）・0337（既定 on）・0352（連想の札は `total` を持たない）・0203 の追記と #1788/#1791 の修正は、順位キー・過取得の幅・同点の並び・`over_limit` の数え方のどれも狭めていない。#1791 は段3.5 で席に着けなかった比較不能の記憶の取り下げを足したもので、`over_limit(association)` の count の式（`associationHits.length − rankFetchHits.length + (rankedCandidates.length − selectedCandidates.length)`）は変えていない。狭まった約束には当たらなかった。
5. 歯の試験が見ている連想用 `search()` の差し替え（`opts.filter` からゲートの欄を剥がす）は、ADR 0034 の「adapter が契約を破ったとき」の再現である。通常の経路では起きないので、そのときの挙動の約束（ADR 0246 決定5）だけを縛る。

## 当てた変異と結果【実測】

#549（main `2761e7ff`、`packages/core` の全試験）

| 変異 | 歯を足す前 | 歯を足した後 |
|---|---|---|
| A1: 類似度だけ（`rankKey = hit.similarity`） | 赤（既存の使用報告の歯） | 赤 |
| A2: `score.total` だけ | 素通り＝穴 | 赤 |
| A3: `similarity × decay` | 素通り＝穴 | 赤（3本） |
| A3b: strength を外す | 素通り＝穴 | 赤 |
| A3c: freshness を外す | 素通り＝穴 | 赤 |
| A3d: tagMatch を外す | 素通り＝穴 | 赤 |
| A4: 降順を昇順にする | 赤 | 赤 |
| A5: 過取得をやめる（`rankFetchCount = maxCount`） | 赤 | 赤 |
| A6: 下限（`Math.max`）を外す | 素通り＝穴 | 赤 |
| A7: `max(0, 総数 − maxCount)` | 素通り＝穴 | 赤 |
| A8: `総数 − 窓の外`（競り負けを数えない） | 赤 | 赤 |
| A9: 競り負けだけ（窓の外を数えない） | 赤 | 赤 |
| A10: `総数 − 席に着いた数` | 素通り＝穴 | 赤 |
| A11: 席を `maxCount + 1` にする | 赤 | 赤 |
| A12: 同点を memoryId で並べる | 素通り＝穴 | 赤 |
| A13: Unit の `rankScore` を `score.total` にする | 素通り・等価 | 緑（等価） |
| A14: 連想の `score.total` を `rankKey` にする | 素通り・等価 | 緑（等価） |
| A15: 窓の外の id を `overLimitAssociationSeatlessIds` に入れない（#1791 の後で足した変異） | 赤 | 赤 |
| A16: 席を競り負けた id を同じ集合に入れない（同上） | 赤 | 赤 |

#550（local-embedding の guard の試験）: G4b・G5・G6・G9・G10・G11 を当てた。いずれも歯を足した試験で赤、戻して緑、`cmp` で一致。

## 確かめていないこと

- A15・A16 は #1791 が足した集合に対する変異で、既存の歯が赤にした。#1791 自身の `promotedFromNotComparable` の取り下げ（`overLimitAssociationSeatlessIds` を比較不能の取り下げの条件に含める行）への変異は、この確かめ直しの射程（09/19 マージ分）の外なので当てていない。
- 実 Postgres では走らせていない（歯は `packages/core` の fake ストアの上）。
- この ADR は main `2761e7ff` の上で測った。その後に main へ入った #1795 などは `recall-runtime.ts` の別の箇所（`over_limit(relation)`）を動かしており、順位キーとは別の箇所だが、取り込み後の再測定はしていない。
