# ADR 0614: 09/27 にマージされた postgres の #1187・#1299・#1289・#1220・#1195 の確かめ直しで見つかった穴に歯を足す（restoreSuperseded の複数 id・語彙クエリの `.` と `-`・searchMany の key の綴り・共有の拡張ロック）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

歯を書くと決めたのも、範囲を決めたのも、クローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は [Issue #1724](https://github.com/takecchi/mnemora/issues/1724)（前の担当 mgr-b2ed6d54 の確かめ直しの結果を写したもの）。クローンのマネージャー（mgr-4e8c690b）が引き継ぎ、担い手2体に書かせた。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】はマネージャーの判定。
これは試験だけの変更で、実装・migration・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0608](./0608-merged-0928-recheck-teeth-a.md) などの試験だけの PR と同じ）。

## 経緯

前の担当が、09/27 にマージされた postgres の5本を、約束ごとに変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った。その担当は器の入れ替えで戻れなくなり、結果は #1724 に写してある。

約束の出所は、各 PR の本文（マネージャーが `gh pr view` で読み、#1724 の「約束の出所」と照合した【現物】）、migration 0023 の注記、`migrate.ts` の TSDoc、`packages/postgres/README.md` の `lock_timeout` の節である。N19 の約束（`RESET` は利用者のロールに設定した値へ戻る）は、#1220 の後の [ADR 0460](./0460-multi-process-multi-pool-round33.md) で広がった側の変化なので、そのまま当てた。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない（公開の約束を増やすのはオーナーの領分。歯は `__tests__` に置く）。
2. 歯を足す（試験だけ）。どの歯も、穴の変異で赤、戻して `cmp` で一致を確かめた後に緑、を実測した【実測。自分専用の PostgreSQL 17 + pgvector、`C.UTF-8`】。

### #1195（`restoreSuperseded` の `onlyMemoryIds`）

置き場: `restore-superseded-malformed-only-ids.postgres.test.ts`（Postgres と testkit の InMemory の2実装）と `store-boundary-diff.postgres.test.ts`。

- **B10**: 3件の群に `[a, b, 形の正しくない id]` を渡すと、a と b だけが戻り、c は戻らない。実行と dryRun の両方。変異（有効な id の先頭1件しか使わない、`.slice(0, 1)`）を restore 側・preview 側に別々に入れ、それぞれ足した歯の1件だけが赤になった。
- **B6'**: `onlyMemoryIds: []` は対象0件。PR の歯と差分の歯の両方に足した。変異（空配列なら句を付けない）で赤。
- **B2**: 差分の歯に `previewRestoreSupersededBy` の場面を足した。実在する群の場面（`{only:[self2, <idKind>]}`・`{only:[]}`）も、restore と preview の両方に足した。既存の `restoreSupersededBy(self, …)` は群が空で、絞り込みが効いているかが見えなかったため。
- **B8・B9**: 差分の歯の `ID_VALUES` に、36文字で hex でない値（`nonHex36`）と、前後に余分が付いた uuid（`padded`）を足した。増やしただけの main で差が出ないことを先に確かめた。変異（「36文字なら通す」「正規表現の `^`・`$` を外す」）で、それぞれの値の場面だけが赤。

### #1289（`aggregateScope` の `digestBand.excludeMemoryIds`）

置き場: `store-boundary-diff.postgres.test.ts`。

- **S3**: `scopeAggregate: "skip"` で `[<idKind>, malformed]` の場面を足した。変異（skip の経路だけ filter を外す）で赤。
- **A6**: 有効な id 2件と形の正しくない id を混ぜた場面を足した（既定と skip）。変異（`.slice(0, 1)`）で赤。
- **A10・A11**: 上の `ID_VALUES` の追加で縛る。

### #1299（`searchMany` の key）

置き場: `vector-search-many-diff.postgres.test.ts`。

- **M8**: 次の3組の key を場面の表に足し、返る `Map` の key が入力と一字一句同じで、結果が混ざらないことを縛る。
  - 前後に空白がある key
  - 合成済みの `é` と分解形の `é`
  - 大文字小文字だけが違う key
  - 変異（返す key を `.normalize("NFC").trim()` する／`.toLowerCase()` する）で、それぞれの組の場面が赤。

### #1187（migration 0023 の `mnemora_lexical_query_tsqueries`）

置き場: `lexical-query-inner-quote.postgres.test.ts`（testkit の InMemory・Postgres の tsvector・trigram の3実装）。

変異は migration のファイルではなく、専用の DB に `CREATE OR REPLACE` で関数を直接当てた。`pg_proc` を読むか関数を直接呼んで、載ったことを確かめた。

- **M10**: `10.0.0.1`・`v1.2.3`・`foo.ts` を含む本文を、同じ文字列で探すと当たる。変異（`.` も空白にする）で、tsvector と trigram の6本が赤になった。testkit は3つとも Postgres と同じ結果だった。
- **M3**: `-1234` で探すと、`-1234` を含む記憶だけが当たる。変異（外側の `"…"` を外す）で2実装とも赤。
  - `or` だけのクエリの歯も足したが、M3 では赤にならない。語に割ってから1語ずつ渡すので、`or` 単独は外側の `"` が無くても素の語として通る。歯として残したのは、`or` の誤爆を見る対照としてである。
- **M2**: 本文 `y z x` を `x"y` で探しても当たらない。変異（隣接を求めない AND）で赤。
- **M7・M8・M13**: `pg_proc` で、`provolatile = 'i'`・`proparallel = 's'`・引数が `(text)` だけ、`mnemora_lexical%` に同名の多重定義が無い、を縛る。各変異で赤。

### #1220（`runMigrations` の共有の拡張ロック）

置き場: 新しい `migrate-extension-lock.test.ts`。専用の DB を作り、`vitest.config.mts` の直列群に入れた。`pg_terminate_backend`・`CREATE ROLE` を使うためである。

時刻とタイミングに触れるので、赤と緑を3回ずつ測った。

- **N3**: 拡張ロックを取る経路でも、本体が `lockTimeoutMs` より長く別のロックを待って、時間切れにならない。
- **N20**: `runMigrations` の後、pool を持ち続けたままでも、別のセッションが拡張ロックを取れる。
- **N19**: `ALTER ROLE … SET lock_timeout = '5s'` のロールで流すと、本体の中でも `5s` のまま。
- **N7・N8**: 拡張ロックを持つファイルの適用中、または拡張の作成中にロックの接続が切れると、元の失敗で reject する。
  - N8 は `pg_extension` を別セッションで排他ロックして待たせる。そのためスーパーユーザーを前提にしている（CI の `postgres` ロールは満たす）。
- **N4 は足していない。** 変異（拡張ロックの待ちに `lock_timeout` を敷かない）を当てると、既存の `tsdoc-5th-sweep-unbound-promises.postgres.test.ts` の「lockTimeoutMs は共有の拡張ロックにも効き…」が3回とも赤になった。#1724 の「すり抜けた」は、このファイルを走らせていなかったためと見ている（推測）。

### `__tests__` で縛る testkit・Fake の穴

置き場: `packages/testkit/src/__tests__/in-memory-id-list-spelling-and-malformed.test.ts` と `packages/core/src/__tests__/fake-id-list-spelling-and-malformed.test.ts`。どちらも DB を使わない。

- #1289 T1・T2'（InMemory の `aggregateScope`）
  - 大文字の id でも除外が効く。
  - 形の正しくない id が混ざっても投げず、有効な2件の除外が両方効く。
- #1195 T1（InMemory）・T3（core の Fake）
  - restore・preview の `onlyMemoryIds` で、大文字の id と形の正しくない id を混ぜても効く。
- 変異（大文字をそろえない／形の正しくない id で投げる）で、足した歯だけが赤になった。既存の `in-memory-uppercase-target-id`・`fake-uppercase-target-id`・`restore-superseded` は緑のままだった（穴の確証）。

## 入れなかったもの

- #1187 M11（0023 の前後で `relfilenode` が変わらないこと）。
- #1220 N10（migrate 中の接続の本数）。
- 適合テストへの追加。

## 引き受けた負債

- 次の2つは、穴の変異では赤にならない。
  - `or` だけのクエリの歯
  - 「やりすぎ側」の変異の一部（N7・N8 の「必ず握り潰す」側）
- N8 の歯はスーパーユーザーを前提にしている。CI のロールが変われば、書き直しが要る。

## これが覆るとしたら

- 適合テストで同じことを縛るとオーナーが決めたら、`__tests__` の歯は重複になるので、畳んでよい。
- 0023 の関数を別の migration で置き換えたら、M7・M8・M13 の歯は、置き換えた先の宣言に合わせて書き直す。
