# ADR 0575: outbox の `eraseTenant`・`claimBatch` の負の `limit` の歯を、プランナの統計によらず reject される入力にする

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

`packages/postgres/src/__tests__/error-message-omits-params.postgres.test.ts` の「`PostgresOutboxStore` を直接呼んだ例外から、params の値を落とす（ADR 0516）」の「eraseTenant: 例外に params の値が無く、SQL の文・SQLSTATE は残る」が、CI の `server_encoding=SQL_ASCII` のジョブで1回だけ「reject しなかった」で落ちた（#1683 の run 37076592218 の1回目。差分はコメントだけで、再実行で緑）。テストだけの変更で、実装は変えない。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 原因

- `PostgresOutboxStore.eraseTenant`（非 dryRun）の文は `WITH victims AS (SELECT id FROM outbox WHERE tenant_id = $1 LIMIT $2) DELETE FROM outbox o USING victims v WHERE …` である。負の `LIMIT` の 2201W は、`Limit` ノードが実行されたときにだけ出る。【現物】
- 自前の Postgres 17（`--encoding=UTF8 --locale=C` と `--encoding=SQL_ASCII --locale=C` の2つ）で測った。両方で結果は同じだった。【実測】
  - 統計が無いとき、計画は `victims` を Nested Loop の外側に置き、`LIMIT -1` は必ず reject される。
  - `outbox.tenant_id` の統計が残っていて、撃つテナントが載っていないとき、計画は `Seq Scan on outbox o` を外側に置く。外側が0行だと、内側の `Subquery Scan v → Limit` は `never executed` になり、reject されない（`EXPLAIN (ANALYZE)` で確かめた。同じ統計の状態で毎回同じ計画）。
  - `claimBatch` も、空の表を `ANALYZE` した状態（`reltuples = 0`）で、CTE `claimable` が結合の内側に回り、同じく reject されない。
  - 同じテナントの行が1本あれば、どの統計の状態でも reject された。
- テストの `resetTestDatabase` は `TRUNCATE` だけで、`pg_statistic` は消えない。同じ worker で先に走った別ファイル（`outbox-claim-lease-index.test.ts`・`outbox-purge-index.test.ts` は `ANALYZE outbox` を撃つ）や autovacuum の統計が残りうる（`vitest.config.mts` の `postgres-db-parallel` は `isolate: false`）。CI で落ちたときの統計の出どころは【未確認】（推定）。
- 他テナントの行を入れて `ANALYZE outbox` した状態で、直す前のテストを走らせると、両方の encoding でこの1本だけが赤になった。【実測】

## 約束との関係（実装を変えない理由）

- 負の `limit` を断る約束は、core の `eraseTenant` 関数（`packages/core/src/erase-tenant.ts`、ADR 0383 決定3: `limit` が正の整数でなければ書き込みの前に `RangeError`）にだけある。store の `OutboxStore.eraseTenant?`・`EraseTenantStoreOptions.limit` の doc は負数について何も約束していない。ADR 0493 の D3 も、store が `eraseTenant` の `limit` で断るものに負数を含めていない（InMemory は `-1` を0件の成功にする）。【現物】
- したがって、Postgres の 2201W は約束ではなく SQL の副作用である。ADR 0516 の歯は、それを「例外から params を落とすか」を見る道具として使っているだけで、負数の約束を縛ってはいない。直すのはテストの側である。【判断】

## 決定

1. 「`PostgresOutboxStore` を直接呼んだ例外から…」の `claimBatch` と `eraseTenant`（非 dryRun）の口は、撃つ前に `obxCtx` のテナントの claim 可能な行（pending、`available_at` が過去）を1本入れる。外側が空にならないので、統計の状態によらず `LIMIT` が評価される。
2. ほかの口（`eraseTenant` の dryRun・`purgeCompletedJobs` とその dryRun・`complete`・`fail`）は変えない。dryRun と `purgeCompletedJobs` は `LIMIT` が最上位にあり、どの状態でも reject されることを測った。【実測】

## 確かめたこと

- UTF8・SQL_ASCII の両方で、揺れを起こす状態（他テナント300行を入れて `ANALYZE outbox`）では、直す前は `eraseTenant` が赤、直した後は対象の describe の全部が緑。統計の無い状態では、直す前も直した後も緑。【実測】
- 統計の無い状態で、テストファイル全体が両方の encoding で緑。packages/postgres の typecheck、対象ファイルの eslint・prettier --check も通った。【実測】
- 直す前と直した後の版の入れ替えは `cp` で行った。立てた Postgres は、使い終わったあと PID を名指しして止めた。
- 【未確認】`claimBatch` の `reltuples = 0` の状態は、テストの中では作れない（`resetTestDatabase` の `TRUNCATE` で `reltuples` が -1 に戻る）。直した版がその状態で緑になることは、仕組みからの判断で、測っていない。

## 同じ形の歯の grep

探した形: `limit: *-[0-9]|LIMIT *-|limit[a-zA-Z]*: *\[?-[0-9]`、`2201W|must not be negative`、`limit: *(NaN|Infinity|1\.5)`、`\[-[0-9]` と `limit` の配列を回す `for`。

- 落ちうる形（`LIMIT` が結合の内側・CTE にある）は、上の2口だけだった。【実測】
- 安全と見たもの: `eraseTenant` の dryRun と `purgeCompletedJobs`（実測）、`EventStore.list(-1)`（`event-filter-actor-schema-vs-store.postgres.test.ts`、古い統計でも reject を実測）、`listActiveClaimPredicates(-1)`（`readme-unbound-promises.postgres.test.ts`、最上位の `LIMIT`。実測していない）、vector の `search`・`searchMany`（最上位の `LIMIT`、`VALUES` が空でない）、非整数の `limit`（bigint への変換の時点で出る見立て）。core が先に `RangeError` で断る歯は DB を見ないので対象外。他の store の `eraseTenant` に負の `limit` を直接撃つ歯は無かった。

## 残り

- `store-boundary-diff.postgres.test.ts` の `claimBatch(limit: -1)` は、同じ形の文を撃ち、InMemory と例外の有無を比べる。同じ状態で揺れうるが、測っていない。揺れが観測されたら同じ手当てをする。

---

## 追記（2026-10-03・出所: ADR 0594 の作業中に、担い手 mgr-d25950ce が実測した。上の「残り」の件）: `claimBatch(limit:-1)` は揺れなかった

上の本文は当時のまま残す。「残り」の `store-boundary-diff.postgres.test.ts` の `claimBatch(limit: -1)` を、実測で答えた。自前の Postgres 17（`--encoding=UTF8 --locale=C`、専用ポート）で測った。【実測】

- **陽性対照（探り棒が効くか）**: psql で、`outbox` を `TRUNCATE` して `ANALYZE`（`reltuples = 0`。`pg_statistic` には前の他テナント 300 行分が残る）し、`claimBatch` と同じ形の文（CTE `claimable` に `LIMIT -1`）を、行の無いテナントで撃つと、エラーが出ない（拒まれない）。同じ状態で撃つテナントの行を 2 本入れると `LIMIT must not be negative` で拒まれる。EXPLAIN では、CTE が Hash Join の Hash 側（内側）に入り、外側の `outbox o` は行ありだった。
- **ファイルを名指しで走らせた結果**（毎回 5 本とも通った）:
  - S0: 統計の無い新品の DB。
  - S2: 空の `outbox` に `ANALYZE` した状態（`reltuples = 0`、他テナント由来の古い統計が残る）。走らせる前に `reltuples = 0` を確認した。
  - S4: 他テナント 5000 行を入れて `ANALYZE`（`reltuples = 5000`）。
- **理由**【判断。実測の EXPLAIN と合っていた】: このファイルの `claimWith` は、`claimBatch` を撃つ前に、同じテナントの行を 2 本（`embed`・`extract`）入れる。`UPDATE … FROM claimable c` の外側 `outbox o` は同じ表なので、その行が見え、外側が空にならない。外側が空にならなければ、内側の CTE（`LIMIT`）は必ず評価され、拒まれる。本文の「同じテナントの行が1本あれば、どの統計の状態でも reject された」と同じ理由である。
- **測っていないこと**: `SQL_ASCII` の DB（本文は両 encoding で同じ結果と書いている。私は UTF8 だけ）。同じ `for` の他の `limit` の値（`0`・`1`・`2**53`・`1.5`・`NaN`・`2**63`。`1.5`・`NaN`・`2**63` は bind の型変換で決まるのでプランナに依らないはずだが、確かめていない）。本文の「他テナント 300 行 + `ANALYZE`」の状態でこのファイルを走らせること（psql で 300 行・`reltuples = 300` までは作ったが、ファイルは走らせていない。代わりに 5000 行で走らせた）。ファイルの実行中に autovacuum が統計を変える場合。
- 揺れなかったので、手当てはしない。

---

## 追記（2026-10-03・出所: ADR 0596（仮番号）の作業中に、担い手 mgr-d25950ce が実測した。「負の `LIMIT` は評価されなければ投げない」の他の口への広がり）: `requeueEmbedJobs`・`archiveDecayed` も同じ形で投げない

上の本文と追記は当時のまま残す。outbox 以外の口の `LIMIT` の位置と、空の表（統計が古い）での結果を測った。自前の Postgres 17（`--encoding=UTF8 --locale=C`、専用ポート）で、使い捨てのテストが store を直接呼んだ。【実測】

- **投げない口（本文と同じ形）**: `PostgresMemoryStore.requeueEmbedJobs` と `archiveDecayed`。`LIMIT` が `WITH target AS (SELECT … LIMIT $n FOR UPDATE SKIP LOCKED) … UPDATE memories m … FROM target t WHERE m.id = t.id` の CTE の中にある。他テナントの行を入れて `ANALYZE` → `TRUNCATE` → `ANALYZE`（`reltuples = 0`）した状態で `limit: -1` を撃つと、`{ requeued: 0, memoryIds: [] }`・`{ archived: [], reachedLimit: false }` で返り、何も書かない。EXPLAIN は `CTE target → Limit (never executed) → LockRows (never executed) → …`、`Update on memories m → Nested Loop → Seq Scan on memories m (actual rows=0) / CTE Scan on target t (never executed)`。撃つテナントの行が3本ある状態、統計の無い状態、他テナントだけ統計がある状態では、どちらも `2201W` で投げた。
- **投げる口**: `EventStore.list`・`VectorStore.search`（統計あり・なしの両経路）・`LexicalStore.search`・`purgeExpiredEvents(-2)`（`-1` は `LIMIT 0` で通る。以前から書いてある）・`aggregateScope` の `digestBand.limit`（GROUP BY の無い集約の副問い合わせなので、必ず1行出て評価される）。どの状態（空で古い・自テナントの行あり・統計なし・他テナントのみ統計あり）でも投げた。最上位の `LIMIT` は `EXPLAIN (ANALYZE)` でも `ERROR: LIMIT must not be negative` になった。
- **NaN・`1.5`**: `requeueEmbedJobs`・`archiveDecayed` も、どの状態でも `22P02`（bigint への変換）で投げた。bind の時点で決まり、`Limit` の評価に依らない。
- **Postgres と突き合わせる既存の歯**: `store-boundary-diff`（`claimBatch(limit:-1)`）・`event-filter-actor-schema-vs-store`・`vector-search-many-diff`・`readme-unbound-promises` を、`outbox` に他テナント由来の古い統計（`reltuples = 0`）を残した状態で名指しで走らせた。24本とも通った。`requeueEmbedJobs`・`archiveDecayed` に負の `limit` を撃つ Postgres 側の歯は、grep では見つからなかった（変数経由の渡し方は拾えていない）。【確かめていない】
- 直したのは、`requeueEmbedJobs`・`archiveDecayed` の fixture・Fake のコメントと、それを引くテスト冒頭のコメントだけ（ADR 0596（仮番号））。
