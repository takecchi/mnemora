# ADR 0683: 09/17 にマージされた #492・#502（`memories` への書き込み時 ANALYZE）の確かめ直しで見つかった穴に歯を足す（Issue #1812、まとまり G3）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1812](https://github.com/takecchi/mnemora/issues/1812)。[ADR 0676](./0676-merged-0917-recheck-teeth.md) が「Postgres が要るので測っていない」と残した G3 を、手元の Postgres 17 + pgvector（`initdb`、[ADR 0183](./0183-local-postgres-makes-postgres-mutation-testing-possible.md) の手順）を立てて測った。
試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。

## 経緯【実測】

main `d811241f` の上で、`analyze-threshold.ts`（`isGeometricAnalyzeThreshold`・`readReltuples`・`maybeAnalyzeTableAfterWrite`・`INITIAL_ANALYZE_THRESHOLD`）21本、`memories-statistics.ts` 5本、`memory-store.ts` の `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` の書き込み時フック 11本、計37本の変異を1本ずつ当てた。「前」は、これらを名指しする既存の5ファイル（`memories-statistics.postgres.test.ts`・`embedding-statistics.test.ts`・`embedding-statistics.postgres.test.ts`・`process-counters-start-at-zero-a/b.postgres.test.ts`）だけで測った。

当てた約束は、#492（ADR 0221）と #502（ADR 0225）に、後の採用済み ADR で変わった分を重ねた今の形である。
- 閾値は初項 1,000 の等比（1,000 / 2,000 / 4,000 / …）ちょうどの書き込みだけ。手前では `pg_class` も読まない。
- 閾値のとき、`reltuples` がこのプロセスの累計以上なら撃たない。小さい・読めない（`-1`）なら `ANALYZE <その表>` を撃つ。ほかの表には触れない。累計は表ごとに数える。
- 数えるのは新しい行を実際に書いた呼び出しだけ（`createMemory`・`createMemoryWithOutbox` は `ON CONFLICT` で既存行を返しただけなら数えない。`supersedeWithNewMemories` は `news` のどれか1件でも新しければ数える）。トランザクションの外で呼ぶので、巻き戻った書き込みは数えない。
- `ANALYZE` の失敗は握り潰さない。

[ADR 0397](./0397-postgres-db-tests-isolate-false.md) と [ADR 0501](./0501-doc-debts-usage-env-analyze-per-process-reinforce-purged.md) が決めた「累計はプロセスごと」「各ファイルの始まりで 0」は、約束が変わったのでなく付け足しなので、そのまま当てた。`createMemoriesWithOutboxAndEvents` のフック（ADR 0410、#1496）は 09/17 のマージ分ではないので、当てていない。

## 穴と足した歯【実測】

37本のうち、等価と判断した2本を除く35本のうち、既存の試験で赤になったのは17本、緑のまま通ったのが穴の18本。

| 側 | 変異 | 前 |
| --- | --- | --- |
| 過 | guard の `reltuples >= count` を `>` にする（累計と同じ行数でも撃つ） | 緑 |
| 過 | 閾値の門を外す（累計が閾値でなくても、統計が古ければ撃つ） | 緑 |
| 過 | `ANALYZE` に表を付けない（DB 全体を撃つ） | 緑 |
| 足 | guard で撃たなかったのに `analyzed: true` を返す／撃ったのに `false` を返す（`maybeAnalyzeTableAfterWrite`） | 緑（2本） |
| 足 | `memories` 側の戻り値の `analyzed` を常に `false` にする | 緑 |
| 足 | `ANALYZE` の失敗を握り潰す | 緑 |
| 過・足 | `INITIAL_ANALYZE_THRESHOLD` を 500／2000 にする（試験が定数を参照していた） | 緑（2本） |
| 過 | `createMemory`／`createMemoryWithOutbox` が既存行を返しただけでも数える | 緑（2本） |
| 足 | `createMemoryWithOutbox` が数えない（本番の書き込みは `Runtime` がこの口だけを呼ぶ） | 緑 |
| 過 | `createMemoryWithOutbox` の数えを、巻き戻りうるトランザクションの先頭へ移す | 緑 |
| 足 | `supersedeWithNewMemories` が `news` の一部だけ新しいと数えない（`every`／先頭の1件だけを見る） | 緑（2本） |
| 過 | `supersedeWithNewMemories` が既存行だけでも、`news` が空でも数える | 緑（2本） |
| 過 | `supersedeWithNewMemories` の数えを、全件が弾かれて巻き戻る判定より前へ移す | 緑 |

足した歯は新規1ファイル `packages/postgres/src/__tests__/memories-analyze-on-write-recheck-0917.postgres.test.ts` の16本。専用の使い捨てデータベースで、表の `reltuples`（`ANALYZE` した瞬間に更新される。`last_analyze` は統計の反映が遅れうるので使わない）と、書き込み累計の読み口 `peekMemoriesWriteCounterForTesting` で縛る。`maybeAnalyzeTableAfterWrite` は初項を引数で取れるので、小さな初項で閾値・guard の境界・表の取り違えを DB の中で決定的に見る。`memories` 側は既定の初項で 1,000 回・2,000 回呼ぶ。初項だけは、定数を参照せず 1,000 と書いた（README と ADR 0221 が約束している値で、定数を参照すると初項を変える変異を縛れない）。全部、足した後に赤、戻して緑、`cmp` 一致。歯が今の約束より強い縛りになっていないかは見直した: 約束にある 1,000、guard の境界、対象の表、数える条件、失敗の伝播だけを縛り、`ANALYZE` を撃つ回数の厳密な上限や、`pg_class` を読む回数は縛っていない。

## 等価と判断した根拠【判断】

- `readReltuples` が表を解決できないとき `undefined` でなく `0` を返す: 呼び側は `undefined`・`0` のどちらでも（累計は 1 以上なので）`ANALYZE` を撃つ。
- `isGeometricAnalyzeThreshold` の `initialThreshold <= 0` の守りを外す: 0 以下の初項では `count % initialThreshold` が `NaN`・または 2 の累乗の判定を通らず、どちらにせよ `false` になる。呼び側は初項に正の定数しか渡さない。

約束に無いので歯にしない: 累計が「呼び出し回数」であって「書いた行数」ではないこと（`news` を3件渡しても 1 しか進まない）。ADR 0225 は「どれか1件でも新しければ呼ぶ」と書き、行数を数えるとは約束していない。ADR 0221 の「書いた行数」という言い方とずれているが、実装はずっとこの形で、`reltuples` との比較が粗くなる向き（`ANALYZE` が余分に撃たれうる側）にしか働かない。

## 決定【判断】

1. 実装・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験だけである。
2. 試験は新規1ファイル。
3. 実バグは無し。

## 確かめていないこと

- `createMemoriesWithOutboxAndEvents` のフック（ADR 0410）は、別のまとまりの約束なので当てていない。
- 別プロセス・別 `Pool` の複数のプロセスが数える形（ADR 0460、0501）。
- フックが `ANALYZE` を撃つ位置がトランザクションの外であること自体（ロックの重なり）。巻き戻った書き込みを数えないことだけを見た。
- `createMemory` のフックをトランザクションの中へ移す変異は当てていない（書き方が大きく変わる）。
- 全テストは流していない。関係するファイルを明示して走らせた。
