# ADR 0662: labels の行ロックの先取り（ADR 0511）の順・取りすぎ・強さを、ロックそのものを外から見る歯で縛る（Issue #1718）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローン（miku）の委譲で動くマネージャー（mgr-946ab0e7）とその作業者が書いた。歯を足すと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は書き手の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0606](./0606-merged-pr-1002-recheck-teeth.md) と同じ扱い）。

## 経緯

- 【現物】[ADR 0511](./0511-label-upsert-cross-memory-and-purge-update-order-deadlocks.md) は、`labels` の行ロックを、どの経路でも名前（コードポイント）順の `FOR UPDATE` で先に取ると決めた。経路は `supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`（共有の `lockExistingLabelsInNameOrder`）と、`purgeMemory`・`scrubPurged` の先取りである。
- 【現物】[ADR 0606](./0606-merged-pr-1002-recheck-teeth.md)（#1719）は、その確かめ直しで、順・取りすぎ・`COLLATE "C"`・`FOR SHARE` の変異が既存の歯をすり抜けることを見つけた。機能の歯（戻り値・行の中身）では原理的に見えないので、[Issue #1718](https://github.com/takecchi/mnemora/issues/1718) に残した。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。
2. `packages/postgres/src/__tests__/label-lock-order-teeth.postgres.test.ts` を足す。ロックを外から見る3つの形で縛る。
   - **A. 先取りの中身を直接見る**（4経路 × 掴む位置2つ × DB 2つ）。別の接続が、語彙のうち名前順で途中の1行を `FOR UPDATE` で掴んでおき、先取りがその行で待つ瞬間に、次を見る。
     - 掴まれている行が、ちょうど「名前順の先頭からその行まで」であること（順。約束3・4・6）。`FOR UPDATE SKIP LOCKED` で数える。
     - 別テナントの同じ名前の行を掴んでいないこと。
     - `labels` への表ロックが弱いもの（`AccessShareLock`・`RowShareLock`・`RowExclusiveLock`）だけであること（`pg_locks`）。
     - `labels` の UPDATE トリガが1回も発火していないこと（行を書いていない）。
     - 無関係なラベルへの書き込みが、`lock_timeout` 300ms で塞がれないこと（約束8）。
   - **B. 経路をまたぐ deadlock**: 名前順にラベルを掴んで眠る upsert の間に、先取りの側を走らせ、`40P01` が出ないこと。
   - **C. `FOR SHARE` への揺れ**: 先取りの後に眠るトリガを置き、同じ語彙の同じ経路を2本同時に走らせて、`40P01` が出ないこと（共有・purge・scrub）。
3. **`COLLATE "C"`**: 名前は、コードポイント順と en-US の照合順序がずれるもの（`B`・`_a`・`a`・`é`・`😀`）にした。A は既定の DB と ICU `en-US` の DB の両方で走る（ICU の DB の作り方は `list-labels-codepoint-order.postgres.test.ts` と同じ）。Postgres のビルドが ICU に対応していなければ、理由を出して skip する（偽の緑にしない）。

## 変異試験【実測】

main `2ab0a054` の木に、自分専用の PostgreSQL 17（`C.UTF-8`、ICU あり）を立てて測った。`memory-store.ts` を `cp` で退避し、変異を1つずつ当てて、新しい歯を**別のコマンドで3回**走らせた。毎回 `cp` で戻し、`cmp` で同一を確かめた。変異なしでは5回連続で 24 本が緑（揺れなし）。

| 変異 | 種類 | 3回の結果（24本中の赤） |
| --- | --- | --- |
| 共有の先取りを `DESC` | すり抜けていた | 10・10・10 |
| 共有の先取りの `ORDER BY` を外す | すり抜けていた | 4・4・4 |
| purge の先取りを `DESC` | すり抜けていた | 5・5・5 |
| purge の先取りの `ORDER BY` を外す | すり抜けていた | 3〜4（3回とも赤） |
| scrub の先取りを `DESC` | すり抜けていた | 5・5・5 |
| scrub の先取りの `ORDER BY` を外す | すり抜けていた | 5・5・5 |
| 共有の先取りがテナントの全ラベルを掴む | すり抜けていた | 8・8・8 |
| scrub がテナントの全ラベルを掴む | すり抜けていた | 4・4・4 |
| purge がテナントの全ラベルを掴む | 既存の歯も捕まえていた | 4・4・4 |
| 共有の先取りの前に `LOCK TABLE labels IN SHARE ROW EXCLUSIVE MODE` | すり抜けていた | 8・8・8 |
| 先取りを `UPDATE labels SET proposed_count = proposed_count` に替える | すり抜けていた | 8・8・8 |
| 3箇所の `COLLATE "C"` を外す | すり抜けていた | 8・8・8 |
| 共有の先取りを `FOR SHARE` | 揺れていた | 2・2・2 |
| purge の先取りを `FOR SHARE` | やりすぎ・弱すぎの側 | 1・1・1 |
| scrub の先取りを `FOR SHARE` | やりすぎ・弱すぎの側 | 1・1・1 |
| 共有の先取りを `FOR UPDATE ... NOWAIT` | やりすぎ | 12・12・12 |
| purge の先取りを `NOWAIT` | やりすぎ | 6・6・6 |
| scrub の先取りを `NOWAIT` | やりすぎ | 6・6・6 |
| 共有の先取りが別テナントの同じ名前の行も掴む | やりすぎ | 8・8・8 |
| purge の前に `LOCK TABLE labels IN EXCLUSIVE MODE` | やりすぎ | 8・8・8 |
| purge・scrub の先取りの `l.tenant_id = …` を `true` にする | やりすぎ | **0・0・0（すり抜け。下の 1）** |
| 共有の先取りを `FOR NO KEY UPDATE` | 弱すぎの側 | **0・0・0（すり抜け。下の 2）** |

## すり抜けたものと、歯を足さない理由【判断】

1. **purge・scrub の先取りの `l.tenant_id = …` を `true` にする変異は、同値変異として扱う。**この先取りは、`l.id IN (SELECT label_id FROM memory_labels WHERE tenant_id = … AND memory_id = …)` でも絞っている。`labels.id` は行ごとに一意なので、`memory_labels` が自分のテナントのラベルだけを指している限り、別テナントの行は対象に入らない。⚠ `memory_labels` がテナントの食い違った行を指す、壊れたデータ（#1743 が検出しようとしているもの）では差が出うる。そこは、この歯の範囲の外とする。
2. **共有の先取りを `FOR NO KEY UPDATE` にする変異は、ADR 0511 の目的に対して等価とみて、歯を足さない。**ADR 0511 の目的は、`labels` の UPDATE（行に `FOR NO KEY UPDATE` を取る）どうしを名前順に直列化し、`40P01` を避けることである。`FOR NO KEY UPDATE` どうしも衝突するので、その直列化は保たれる。違いは、外部キーの検査（`memory_labels` の INSERT が取る `FOR KEY SHARE`）を塞ぐかどうかだけである。ADR 0511 の本文は「`FOR UPDATE`」と書いているが、その強さ自体を約束とは読まなかった。強さを約束にするなら、`FOR KEY SHARE` が待たされることを見る歯が要る。

## 引き受けた負債

- 歯は1回 30 秒ほどかかる（ロックの待ちを作るため）。
- 手元の器は `C.UTF-8` で、既定の DB では `COLLATE "C"` の差が出ない。差は ICU `en-US` の DB で見ている。CI の UTF8 の脚（`en_US.utf8`）の既定の DB では、手元で走らせていない。
- 上の1・2は縛っていない。

## これが覆るとしたら

- ADR 0511 の先取りの形（絞り方・ロックの強さ）が変わったとき。
- ロックの強さ（`FOR UPDATE` そのもの）を約束として縛る必要が出たとき（上の2）。
