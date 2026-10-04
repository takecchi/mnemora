# ADR 0612: 10/01 にマージされた #1552・#1555・#1556・#1561・#1562・#1564・#1568・#1572・#1582・#1583 の確かめ直しで見つかった穴に歯を足す（補助の欄の落とし・使用報告の崖・接続の後始末・savepoint の release・consolidate の落とした欄の記録・lock_timeout の失敗経路・NUL の検査の順）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-fc93a777）の依頼で、担い手が書いた。歯を書くと決めたのも、範囲を決めたのもクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0608](./0608-merged-0928-recheck-teeth-a.md)・[ADR 0611](./0611-merged-0928-recheck-teeth-b.md) などの試験だけの PR と同じ）。
この PR は「PR A」で、PR B は ADR 0613（#1728）である。

## 経緯

2026-10-01（UTC）にマージされた10本の PR を、約束ごとに、足りない側とやりすぎ側の変異を入れて確かめ直した。変異は、実装のファイルを `/tmp/mgr-fc93a777-a-orig/` へ `cp` で退避し、Edit で1つ入れ、名指しのファイルだけを走らせ、`cp` で戻して緑に戻ることまで見た【実測】。どの歯にも捕まらない変異（穴）にだけ歯を足した。

約束の出所は、各 PR の本文（担い手が `gh pr view` で読んだ）、実装の TSDoc・コメント、その PR の ADR（0443・0444・0448・0451・0454・0456・0460・0464・0473・0476）である【現物】。後の ADR で約束が変わっていないかは、`docs/decisions` を ADR 番号・関数名で `grep` して見た。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない（歯は `__tests__` に置く）。
2. 歯を足したのは次のとおり（置き場は `packages/*/src/__tests__/`）。
3. 試験名・コメントに「ADR X 決定N」の形の参照は書かない。

### #1552（補助の欄の落とし・id の数の崖）

出所: PR 本文の「直したもの」1・2、`llm-aux-fields.ts` の TSDoc（「ほかの要素の並び・重複・前後の空白はそのまま残す」「空白だけの要素はここでは扱わない」）。

- `core/llm-aux-fields.test.ts`: NUL の要素を捨てるときも、残す要素の前後の空白・空白だけの要素・重複はそのまま残す。空白だけの digest は NUL ではないので落とさず、記録も残さない。
- `postgres/bind-parameter-limit-cliff.postgres.test.ts`: `memory_usage` の使用報告に 33000 件を足した。使用の記録（`recall_usages` の INSERT）が id を1件ずつ2か所にバインドする形に戻ると、約32768件で崖になる。既存の 13106・13107 件は強化（`reinforceMany`）の崖を見ていて、そこには届かない。

### #1555（接続の後始末・closePostgresClient）

出所: PR 本文の BG-1・BG-2・BH(c)、`client.ts` の TSDoc とコメント（「壊れた接続を pool へ戻さない」「捨てる接続のリスナーは外さない」「差し替えた `query` を次の貸し出しへ持ち越さない」「`ending` なら終わるまで待つ」）。

- `postgres/transaction-rollback-error.postgres.test.ts`: 接続が生きたまま `rollback` だけが失敗しても、その接続は pool に戻らず捨てられる（開いたままのトランザクションを次の借り手へ渡さない）。`pg_terminate_backend` では接続ごと切れて pg が自分で捨てるので、既存の歯は見分けられない。`rejectStatement` で `rollback` だけを失敗させる。
- `postgres/transaction-begin-release.postgres.test.ts`: 捨てる接続（`release(err)`）には `error` リスナーを残し、返す接続（`release()`）からは外す。`release` のあと差し替えた `query` は接続に残らない。
- `postgres/client-close-idempotent.postgres.test.ts`: 借りられたままの接続があって `pool.end()` が終わらないあいだは、`closePostgresClient` も resolve せず、返されて終わったら resolve する。

### #1561（savepoint の release）

出所: PR 本文「`release savepoint` の失敗は、その候補を落とさず、その失敗を投げる」、`createMemoriesWithOutboxAndEvents` のコメント（本体が投げたエラーを控える）。

- `postgres/savepoint-rollback-error.postgres.test.ts`: 悪い候補（`rollback` は成功して `dropped`）のあとの良い候補で `release savepoint` が失敗したとき、前の候補の失敗ではなく `release` の失敗を投げる（何も残らない）。

### #1562（consolidate・reflect の落とした欄の記録・extractorVersion の検査の順）

出所: ADR 0456 の「引き受けた負債」（`droppedFields` の `index` は常に 0、`contentHash` は統合先・内省の本文のハッシュ）、H3 の決定（`observationId` が uuid の形でないときは今までどおり DB に行かず `[]` を返すので、その後で検査する。断る入力は増やさない）。

- `core/llm-malformed-aux-values.test.ts`: consolidate・reflect の `droppedFields` の1件ごとの中身（`index`・`contentHash`・`field`・`reason`・`count`・`tagIndexes`）と、落とした値そのものを写さないこと。
- `postgres/read-scope-filter-nul.postgres.test.ts`: `listBySourceObservation` は、`observationId` が uuid の形でなければ、`extractorVersion` に NUL があっても `[]` を返す。

### #1568（lock_timeout の失敗経路）

出所: PR 本文「呼び終えた接続の `lock_timeout` を `0` に書き換えない」、`advisory-lock.ts` の TSDoc（「終了時に `RESET lock_timeout` で接続の既定値へ戻す」）。

- `postgres/advisory-lock-cleanup.postgres.test.ts`: `options` で `lock_timeout=7s` を渡した pool で、取得が時間切れになったあとも、どの接続の `lock_timeout` も 7s のまま。

### #1583（診断の改善）

- `postgres/label-upsert-lock-order.postgres.test.ts` の1本目: 落ちた作成の理由（`cause` の SQLSTATE と文面）を `failures` に積み、`proposedCount` の比較より前に `expect(failures).toEqual([])` で赤くする。歯の判定は変えず、赤の理由が deadlock（40P01）だと読めるようにした。

## 実測【実測】

PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のインスタンス）。「穴」は足りない側、「やりすぎ」は正しい振る舞いまで壊す向きの変異。「既存」はこの PR より前から在った歯、「新しい歯」はこの PR で足した歯。

| PR | 変異 | 赤になった歯 |
| --- | --- | --- |
| #1552 | 穴: NUL の要素を捨てるとき、残す tag を `trim()` する | 新しい歯1本。既存は緑のまま |
| #1552 | やりすぎ: 空白だけの digest も落とす | 新しい歯1本。既存は緑のまま |
| #1552 | 穴: `reextract` の `sanitizeCandidatesAuxFields` を外す | 既存2本（InMemory・Postgres）。core の単体は緑 |
| #1552 | 穴: claim key の NUL 検査を外す | 既存2本 |
| #1552 | 穴: deferred の呼び出し中だけ落としを外す（`runExtraction` は sync と共有。グローバルの印で deferred だけに当てた） | 既存2本 |
| #1552 | やりすぎ: `meta.droppedFields: []` を常に付ける | 既存2本 |
| #1552 | 穴: `reinforceMany` の `unnest` の列を入れ替える | 既存1本 |
| #1552 | 穴: `SEARCH_MANY_CHUNK_SIZE` を 32768 にする | 既存4本 |
| #1552 | 穴: 使用の記録の `unnest` を `VALUES` に戻す | 新しい歯1本（33000件）。既存（13106・13107件）は緑のまま |
| #1555 | 穴: `rollback` の失敗で `discardWith` を立てない | 新しい歯1本。既存は緑のまま |
| #1555 | やりすぎ: 捨てる接続のリスナーも外す | 新しい歯1本。既存は緑のまま |
| #1555 | 穴: `ending` の pool を待たずに resolve する | 新しい歯1本。既存は緑のまま |
| #1555 | 穴: `delete client.query` を外す | 新しい歯1本。既存2本も赤だが、故障注入が古い包みに迂回されたためで、持ち越しそのものを見てはいない |
| #1555 | やりすぎ: `ROLLBACK_STATEMENT` の末尾 `$` を外す | 既存7本（ADR 0451 の歯） |
| #1555 | 穴: 借りた接続のリスナーを `release()` でも外さない | 既存1本（`drizzle-pool-proxy.test.ts`） |
| #1555 | 穴: `cause` が空でも `rollbackError` にだけ置く | 既存2本（うち1本は新しい歯） |
| #1555 | 穴: `cause` が埋まっていても `cause` を上書きする | 既存1本 |
| #1555 | 穴: 元のエラーでなく `rollback` の失敗を投げる | 既存5本 |
| #1555 | 穴: `docs/memory-model.md` §11 の行2の行き先・行11のイベント名を変える | 既存各1本 |
| #1556 | 穴: `cli-pool.ts` の警告から `error.message` を外す | 既存1本 |
| #1556 | やりすぎ: 「`.sql` が1本も無い」警告を、全部適用済みのときにも出す | 既存2本 |
| #1556 | 穴: runner が `SET statement_timeout = 0` を挟む | 既存1本（ADR 0589 の歯） |
| #1556 | 穴: `migrationsDir` の読み取りを DB に触れた後へ移す | 既存2本 |
| #1556 | 穴: 読めない例外の `cause`・元の `code` を外す | 既存1本・2本 |
| #1561 | 穴: `bodyError` の宣言をループの外へ出す | 新しい歯1本。既存は緑のまま |
| #1561 | やりすぎ: 悪い候補を `dropped` に積んだあと `break` する | 既存4本（新しい歯も赤） |
| #1561 | 穴: 巻き戻しの失敗を常に `rollbackError` に付ける | 既存2本 |
| #1562 | 穴: consolidate の `droppedFields` の `index`・`contentHash` を変える（reflect は `index` を変える） | 新しい歯1本（両方）。既存は緑のまま |
| #1562 | 穴: `extractorVersion` の NUL 検査を `uuid` の形の確認の前へ移す | 新しい歯1本。既存は緑のまま |
| #1562 | やりすぎ: `ObserveResult.rejectedSubjectIds` を常に付ける | 既存2本（出力契約の見張り） |
| #1562 | やりすぎ: `aggregateScope` が `skip` でも NUL を検査する | 既存1本 |
| #1562 | 穴: `insertCreatedEventRow`・`resolveOrphanedContested` の `assertEventTargetInTenant` を外す | 既存各1〜3本 |
| #1562 | 穴: `sanitizeCandidateSubjectId` の判定を外す（NUL・孤立サロゲートが別々の it で赤） | 既存2本 |
| #1562 | 穴: consolidate・reflect の落としを外す | 既存各1本 |
| #1562 | 穴: `labels`・`attributes` の key・value の検査を外す | 既存3〜4本ずつ（key は Trigram の歯だけが緑） |
| #1562 | 穴: claim key（`findActiveByClaimKey`・`findContestedByClaimKey` の subject・predicate）・`extractorVersion` の検査を1つずつ外す | 既存各1本 |
| #1562 | 穴: 口ごとの `assertNoNulInScopeFilter` を外す（aggregateScope・Lexical・Trigram・Vector search・searchMany） | 既存各1本 |
| #1564 | 穴: 既存の全行にぶつかる候補を避ける・全候補がぶつかっても supersede する・最後の候補を選ぶ・口なしの経路を `memoryIds[0]` に戻す | 既存4〜8本 |
| #1564 | 穴: 冪等な再送の戻り値の欄を変える・常に付ける・`claimedBy` を渡さない | 既存各1〜8本 |
| #1568 | 穴: 失敗経路の `RESET lock_timeout` を `set_config('lock_timeout','0',false)` にする | 新しい歯1本。既存は緑のまま |
| #1568 | 穴: 失敗経路の `RESET lock_timeout` を外す | 既存1本 |
| #1568 | 穴: DDL の前の `RESET lock_timeout` を外す | 既存1本 |
| #1568 | 穴: DDL を `lockClient` でなく `pool.query` で打つ | 既存1本（約30秒で `timeout exceeded when trying to connect`） |
| #1572 | 穴: `memory_id` の索引・零ノルムの索引の包みを外す・名前を取り違える・`constraint` の照合を外す | 既存各1本 |
| #1582 | 穴: Postgres の `findActiveByClaimKey`・`findContestedByClaimKey`、InMemory の `findActiveByClaimKey`・`findContestedByClaimKey`、core Fake の `findActiveByClaimKey` の、空区間の判定（問い合わせ側・行の側）を外す | 既存各2本ほか |
| #1582 | 穴: core Fake の `findContestedByClaimKey` の空区間の判定を外す | この PR の歯は緑のまま。後の歯 `fake-claim-key-parity.test.ts`（ADR 0539）だけが赤。**歯は足していない** |
| #1583 | 穴: 名前順の並べ替えを外す | 既存1本。`failures` は 40P01 `deadlock detected` の4件（診断を足して確認） |
| #1583 | やりすぎ: 重複の除去を外す | 既存1本 |
| #1583 | 穴: コードポイント順を `localeCompare` にする | この PR の歯は緑のまま。後の歯 `labels-vocabulary-teeth.postgres.test.ts`（ADR 0511）が3本赤。**歯は足していない** |

足した歯は、すべて、その変異でだけ赤くなり、戻すと緑になることを実測した。足した歯を含む10ファイルを、最後にまとめて走らせ、緑だった。

## 外したもの

等価な変異・観測できない変異（再検証していない【判断】）。

- **#1556 `RESET statement_timeout` を挟む変異**: `RESET` は接続の起動時の値に戻すだけで、本体から見える値が変わらない（等価）。
- **#1561 `attachSavepointRollbackError` の「`Error` でないものには添えない」**: store の内側に `Error` でない値を投げる経路が無く、変異が観測できない。
- **#1562 `knownInTenant`（今更新した行の id なら問い合わせない）を外す変異**: 往復が1本増えるだけで結果が変わらない。
- **#1552 の `searchMany` のチャンクを同じトランザクションで撃つこと**: 別にしても結果が変わらない。
- **PR 本文が引き受けた負債・材料**: #1552 の長い tag・anchorCount、#1555 の `rollbackError` の上書き、#1561 の外側 `rollback` の失敗、#1568 の逆向きの競合、#1572 の逆向きの競合。

## 縛っていないもの

- **#1582 と #1583 の「後の歯だけが噛んだ」変異**: #1582 の core Fake の `findContestedByClaimKey` と、#1583 のコードポイント順は、PR 自身の歯では噛まず、後の歯（ADR 0539・0511）だけが噛んだ。後の歯が噛むので、この PR では歯を足していない。後の歯が消えたら、この2つは縛られなくなる。
- **#1568 の古い歯 B1・B2**: `advisory-lock-cleanup.postgres.test.ts` の B1・B2 は「`lock_timeout` が `'0'` に戻る」と書いている。これは直す前の約束の名残で、利用者が値を渡していない pool では `RESET` と同じ値（`0`）に見える【現物】。書き換えず、足した歯（`lock_timeout=7s` を渡した pool）で補った。
- **#1562 の `rejectedSubjectIds` の TSDoc の読み**: ADR 0456 は「一覧を渡したときだけ載る」と書く。`extractCandidates` の戻り値は、一覧が無くても弾いた `subjectId` を `rejectedSubjectIds` に入れ、`ObserveResult` に載せるかどうかは Runtime の条件（`subjectCandidates` を渡したときだけ）で守られている【現物】。出力契約の見張りが守っており、バグではない。TSDoc の読みが割れうる点だが、直しが要るかは判断しない（オーナーの領分）。
- **#1562 の Trigram の `attributes` の key の NUL**: Trigram の歯は key の NUL を入れていない。検査は共有部で、ほかの3口が噛むので、口ごとの穴ではない。
- **#1555 の `delete client.query` の既存2本**: 赤にはなるが、故障注入が古い包みに迂回されたためで、持ち越しそのものは新しい歯で縛った。
- **#1583 の歯の時間依存**: 6接続×6ラウンドの形は時間に依る。赤の理由が deadlock であることは、1回の走りで確かめた【実測】が、件数は走るごとに変わりうる。
- **#1555 の「接続を張った直後に切られて落ちる窓」**: 決定的に作れず、変異を当てていない。
- **全テストはローカルで走らせていない**。名指しのファイルだけ。

## これが覆るとしたら

#1552 の「保存できる値は落とさない」と `memory_usage` の `unnest`、#1555 の「壊れた接続を pool へ戻さない」「`ending` なら待つ」、#1561 の「`release savepoint` の失敗はその失敗を投げる」、ADR 0456 の `droppedFields` の `index`・`contentHash`、#1568 の「呼び終えた接続の `lock_timeout` を書き換えない」が変わるとき。
