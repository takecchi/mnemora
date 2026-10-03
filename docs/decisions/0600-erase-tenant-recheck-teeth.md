# ADR 0600: eraseTenant（ADR 0383）の確かめ直しで見つかった穴を塞ぐ（他テナントの自己参照・dryRun・confirmTenantId の完全一致・他テナントからの参照の検査・limit・他テナントの冪等キーなど）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）の作業者が書いた。歯を書くと決めたのは、そして「約束の文面にあるもの」だけに絞ったのは、クローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0598](./0598-adr-0490-0480-0485-merged-pr-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯【実測】

PR #1444（`eraseTenant`、[ADR 0383](./0383-erase-tenant.md)）を独立に確かめ直し、約束ごとに「足りない実装」「やりすぎた実装」の変異を当てた。postgres の7ファイルと適合テストを通り抜けた変異は次のとおり。

| #   | 約束（出所）                                                                                                                                       | すり抜けた変異                                                                                                                                                   | 通った理由                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | 他テナントの行は書き換えない（`MemoryStore.eraseTenant` の契約・`VectorStore.eraseTenant?` の「`ctx.tenantId` に属さない行は消さない」と同じ境界） | postgres の自己参照の `NULL` 化の `UPDATE` から `tenant_id` の条件を外す                                                                                         | 別テナントに `superseded_by_id`・`contested_with_id` を持つ行を置く歯が無かった      |
| 2   | `dryRun` は何も書かない（interface の TSDoc）                                                                                                      | 自己参照の `NULL` 化を `dryRun` でも行う                                                                                                                         | 自己参照を持つテナントに `dryRun` を当てる歯が無かった                               |
| 3   | `confirmTenantId` は完全一致で比べる（`erase-tenant.ts` の関数の TSDoc「完全一致で比べる」）                                                       | 大文字小文字を無視して比べる                                                                                                                                     | 不一致の入力が `tenant-2` だけだった                                                 |
| 4   | 他テナントからの参照だけが `blocked_by_foreign_reference` にする（`countForeignReferences` の説明）                                                | `mine.tenant_id = $1` を外す                                                                                                                                     | 他テナント同士の参照（A が B を参照）がある状態で、無関係な C を消す歯が無かった     |
| 5   | 下の「決定」の項5                                                                                                                                  | `drainById` の victims を `LIMIT budget + 1` にする／vector の `remaining -= deleted` を抜く／Fake・InMemory の他テナントの outbox・vector・設定・冪等キーを消す | 各々、歯が1回で `limit` を超えるかを見ていない・1 space だけ・memory 1件だけ、だった |

## 決定【判断】

1. 実装は変えない。
2. 歯を足す（試験だけ）。
   - **穴1**
     - `packages/testkit/src/memory-store-conformance.ts`（InMemory と postgres の両方に流れる）の「`eraseTenant` は他テナントの自己参照（`supersededById`・`contestedWithId`）を書き換えない」。テナント A・B の両方に superseded の組と contested の組を作り、A を消した後、B の2列が消去の前後で変わらないこと。contested の組は `markContestedPair`（任意メソッド）を持つ adapter でだけ作る。
     - `packages/postgres/src/__tests__/erase-tenant.postgres.test.ts` の「自己参照の NULL 化は対象テナントの行だけに及ぶ」。同じことを生 SQL で2列を読んで縛る（store の読み口を通さない）。
   - **穴2**: 適合テストの「`dryRun: true` のとき、自己参照を書き換えない」と、postgres の同名の歯。
   - **穴3**: `packages/core/src/__tests__/erase-tenant.test.ts` の「`confirmTenantId` は完全一致で比べる」。`ctx.tenantId: "Acme"` に対して、`acme`・`ACME`・前後の空白・末尾の改行・1字足りない・1字多い・1字違いを、すべて `RangeError` で断り、記憶が残ること。対照として `Acme` ちょうどは通ること。
   - **穴4**: postgres の「他テナント同士の参照（A が B を参照）は、無関係なテナント C の `eraseTenant` を止めない」。C は実行され、A・B の行は無傷。対照として B を消そうとすると `count: 1` で止まる。
3. 約束の文面にあるので入れたもの（穴5）。
   - **1回の呼び出しで `limit` を超えて消さない**: 適合テストの「`limit: k` の1回で `deleted` は k 以下、残りはちょうど n-k」。根拠: `EraseTenantOptions.limit` の TSDoc「1回の呼び出しで削除する目安の上限」と、`reachedLimit` の説明（「ある表でちょうど `limit` 件消せたとき」）。
   - **vector は全 space の合計で budget を使う**: `packages/testkit/src/vector-store-conformance.ts` の「`limit` は全 space の合計に対する上限」。2 space に2件ずつ、`limit: 3` の1回で `deleted` は 3、残りはちょうど1件。根拠: `PostgresVectorStore.eraseTenant` の TSDoc「`opts.limit` は全 space の合計に対する budget として消費する」と、`VectorStore.eraseTenant?` の契約「`opts.limit` を目安に、adapter が持つ全 space のテーブルから…削除する」。
   - **Fake・InMemory が他テナントの outbox・vector・設定・冪等キーを消さない**: core の Fake に対しては `erase-tenant.test.ts` の「他テナントの outbox・埋め込み・設定・冪等キーも消えない」。testkit の InMemory（と postgres）の冪等キーは、適合テストの「他テナントの冪等キーを消さない（同じ内容をもう一度書いても二重には作られない）」。根拠: `eraseTenant` の TSDoc の「他テナントの行は書き換えない」にあたる各 port の契約（`VectorStore.eraseTenant?` の「`ctx.tenantId` に属さない行は消さない」など）。outbox・vector・設定の InMemory 側は、既存の各 conformance（`outbox-store-conformance.ts`・`vector-store-conformance.ts`・`tenant-settings-store-conformance.ts`）が他テナントの無傷を見ているので、足していない。
4. 約束の文面に無いので入れないもの（下の「縛っていないもの」）。

## 変異試験【実測】

実装ファイルを `/tmp/mgr-9a36f2f4-wt12-bak/` に `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせて赤を確かめ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。postgres は本物の Postgres 17（ポート 55371）に対して走らせた。

| 変異（側）                                                                    | ファイル                               | 赤になった歯                                                                                                      | 戻して                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `UPDATE` から `tenant_id` を外す（やりすぎ）                                  | `memory-store.ts`（postgres）          | 適合の穴1の歯（B の3列が `null` に）、postgres の穴1の歯と穴4の歯                                                 | postgres の適合テスト（`-t eraseTenant`）21本・`erase-tenant.postgres.test.ts` 9本緑 |
| 自己参照の `NULL` 化を `dryRun` でも行う（やりすぎ）                          | 同上                                   | 適合の穴2の歯、postgres の穴2の歯                                                                                 | 同上                                                                                 |
| `countForeignReferences` から `mine.tenant_id` を外す（やりすぎ）             | 同上                                   | postgres の穴4の歯（`blocked_by_foreign_reference` で返る）。ほかに同じファイルの4本も赤（数えすぎ: `count: 76`） | 同上                                                                                 |
| `drainById` の victims を `LIMIT budget + 1`（やりすぎ）                      | 同上                                   | 適合の `limit` の歯（`expected 3 to be less than or equal to 2`）                                                 | 同上                                                                                 |
| `drainById` の victims を `LIMIT max(budget-1, 1)`（足りない）                | 同上                                   | 適合の `limit` の歯（`expected 4 to be 3`）。既存の `reachedLimit` の歯も赤                                       | 同上                                                                                 |
| vector の `remaining -= deleted` を抜く（やりすぎ）                           | `vector-store.ts`（postgres）          | 全 space の合計の歯（`expected 4 to be 3`）                                                                       | 適合 21本緑                                                                          |
| `remaining -= deleted + 1`（足りない）                                        | 同上                                   | 同じ歯（`expected 2 to be 3`）                                                                                    | 同上                                                                                 |
| `confirmTenantId` を小文字化して比べる（やりすぎ）                            | `erase-tenant.ts`（core）              | 完全一致の歯（`promise resolved … instead of rejecting`）                                                         | `erase-tenant.test.ts` 17本緑                                                        |
| `confirmTenantId.trim()` で比べる（やりすぎ）                                 | 同上                                   | 同じ歯                                                                                                            | 同上                                                                                 |
| Fake の `extractionIndex` を、テナントを問わず消す（やりすぎ）                | `runtime-fakes.ts`（core）             | 他テナントの歯（`expected true to be false`。冪等キーが消えて二重に作られる）                                     | 同上                                                                                 |
| Fake の outbox の消去がテナントを問わない（やりすぎ）                         | 同上                                   | 同じ歯（`expected +0 to be 2`）                                                                                   | 同上                                                                                 |
| Fake の vector の消去がテナントを問わない（やりすぎ）                         | 同上                                   | 同じ歯（`expected +0 to be 1`）                                                                                   | 同上                                                                                 |
| Fake の設定の消去で `eventRetentionDays` を全テナント分 `clear()`（やりすぎ） | 同上                                   | 同じ歯（`expected { kind: 'unset' } to deeply equal { kind: 'days', days: 30 }`）                                 | 同上                                                                                 |
| InMemory の `extractionIndex` を、テナントを問わず消す（やりすぎ）            | `in-memory-memory-store.ts`（testkit） | 適合の冪等キーの歯（`expected true to be false`）                                                                 | testkit の適合 22本緑                                                                |
| InMemory の `drainMap` の budget を `remaining + 1`（やりすぎ）               | 同上                                   | 適合の `limit` の歯（`expected 3 to be less than or equal to 2`）                                                 | 同上                                                                                 |

足りない側（消さない・消し残す）は、既存の歯（消去の後に記憶が無いこと、再利用の歯、`reachedLimit` の歯）が捕まえるので、新しい歯の足りない側の変異は `limit` と vector の budget だけ当てた。穴1・2・4 の足りない側は、既存の歯と、穴4の対照（B を消そうとすると止まる）が見る。

## 縛っていないもの

- **lock のキー（別のテナントを待たせない）**: 約束の文面（ADR 0383・ADR 0430 の決定と interface の TSDoc）には「別のテナントは待たない」と書いてあるが、これは性能・並行の性質であり、確かめるには並行の仕掛けが要る。今回の穴のうち、約束の文面が「他テナントの行を書き換えない」「`dryRun` は書かない」「完全一致」と、中身の振る舞いで書いているものに絞る、というクローンの判断で、入れていない。既存の `erase-tenant-concurrent-other-tenant.postgres.test.ts` がある。
- **`limit` の上限（2^53 など）**: 約束の文面が上限を決めていない（`limit` は「正の整数」とだけ書いてある）ので、入れない。
- 足りない側の変異を、新しい歯のすべてには当てていない（上のとおり）。
- 適合テストの contested の組は、`markContestedPair` を持たない adapter では作らない（`superseded` の組だけを見る）。今回の2実装（InMemory・postgres）はどちらも持つ。

## これが覆るとしたら

`eraseTenant` が他テナントの行に触れてよいと決めるとき（ADR 0383）。`confirmTenantId` の比べ方を完全一致以外にするとき。`limit` が全 space・全表の合計の上限でなくなるとき。lock のキーや `limit` の上限を約束の文面に書き足すとき（そのときは並行の歯・境界の歯を足す）。
