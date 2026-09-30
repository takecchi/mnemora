# ADR 0371: `packages/postgres` の DB テストをファイル並列にする——worker ごとに専用 DB を TEMPLATE で複製する

- **状態**: 採用 (2026-09-29)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから委譲された、
> クローン miku の委譲先）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) の
> 同種の注記と同じ——repo 上の署名だけではオーナー本人と区別が付かない。
> **この決定を担い手が自分で下してよい根拠は
> [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)** である。
> [Issue #1277](https://github.com/takecchi/mnemora/issues/1277) は「案と実測だけで、実装はしない」
> として起票にとどめられていた（クローン miku の判断）。この ADR はその続きとして、
> 起票で挙がった2案（スキーマごと／DB ごと）のうち「DB ごと」を実装した記録である。
> 方向そのもの（並列にするかどうか）の変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0253・0358・0361・0366 の体裁を踏む）。

- **【現物】** — この repo のコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で PostgreSQL 17 + pgvector を走らせて確かめた。
- 推測 — 出所を明示していない考察・見立て。

---

## 文脈

[Issue #1277](https://github.com/takecchi/mnemora/issues/1277) が【現物・要約】:

`packages/postgres/vitest.config.mts` は `fileParallelism: false` で、DB テストのファイルを
1本ずつ直列に走らせていた。CI の `postgres` ジョブの実測（main の run 36339162899）では、
`test:db` の Duration のうち import（ファイルを1本ずつ読み込むために直列に積み上がる分）が
UTF8 で 23%（約82s）、SQL_ASCII で 18%（約57s）を占めていた——並列にすれば重なる。

並列にできない理由は、多くのファイルが `resetTestDatabase()`（`test-db.ts`）で共有 DB の
ドメイン表を `TRUNCATE` すること、加えて一部のファイルが `pg_stat_activity` /
`pg_terminate_backend` / `pg_locks` / `CREATE ROLE` などクラスタ全体に効くものを使うことだった。

Issue #1277 は2つの案（ファイルごとのスキーマ／ファイルごとの DB）を挙げ、実装はせずに
起票にとどめていた。この ADR はその続きで、「DB ごと」を実装した。

---

## 採った案: worker ごとの専用 DB（TEMPLATE で複製）

1. vitest の `globalSetup`（`global-setup-worker-databases.ts`、メインプロセスで1回だけ
   実行される）が、`DATABASE_URL` の指す DB に migrate と `registerEmbeddingSpace` を済ませ
   （`test-db.ts` の `getTestClient()` と同じ処理）、以後は**この DB を直接テストに使わず**
   TEMPLATE としてだけ使う。
2. 並列 project の**解決後の** `maxWorkers`（`project.config.maxWorkers`）を読み、
   `<base>_w1` .. `<base>_w<N>` と、直列 project 用の `<base>_serial` を
   `CREATE DATABASE … TEMPLATE <base>` で複製する。前回の中断の残骸（同じ命名規則に
   一致する DB）は、複製の前にすべて `pg_database` から拾って落とす。
3. `setupFiles`（`setup-worker-database.ts`、worker ごと・テストファイルごとに実行される）が
   `process.env.VITEST_POOL_ID`（vitest 5 で worker に割り当てられる 1..maxWorkers の
   値。詳細は下の「vitest 5.0.0 の実測」）を読み、`process.env.DATABASE_URL` をその worker
   専用の DB へ書き換える。`resetTestDatabase()` はその DB の中だけを `TRUNCATE` するので、
   他の worker と競合しない。
4. teardown（globalSetup が返す関数）で、作った worker DB を `temp-database.ts` の
   `dropTempDatabase`（ADR 0020 と同じ「接続0本を実測してから FORCE 無しで DROP」）で落とす。

### `vitest.config.mts` を2つの project に分ける

`test.projects` で並列 project（`postgres-db-parallel`）と直列 project
（`postgres-db-serial`、`fileParallelism: false`）に分け、`test.sequence.groupOrder`
で並列 project を 0、直列 project を 1 にする——「同じ groupOrder は並行、異なる
groupOrder は低い方から高い方へ順に、重ならず」実行される（下の「vitest 5.0.0 の実測」）。

---

## vitest 5.0.0 の実測（実装を進める前に確認した——タスクの指示どおり、
## `sequence.groupOrder` が使える／重ならないことを保証できなければここで止まる約束だった）

**この repo の `packages/postgres` の `node_modules`（vitest 5.0.0）を使い、
`.poc/`（コミットしない使い捨てのディレクトリ）に最小構成を作って確認した。**

1. **`test.sequence.groupOrder` は実在し、期待どおり動く**【実測】。2つの project
   （`parallel`: `maxWorkers: 2`, groupOrder 0 / `serial`: `fileParallelism: false`,
   groupOrder 1）を作り、`parallel` 側に 1.5秒 sleep するテストを入れて実行したところ、
   `serial` 側のテストは `parallel` 側の最後のテストが終わった **304ms 後**に開始した
   （タイムスタンプで確認。重ならない）。

2. **`globalSetup` は project ごとに宣言すると project の数だけ実行される**【実測】。
   2つの project それぞれに `globalSetup` を宣言したところ、`setup(project)` が
   2回（`parallel` 用・`serial` 用）呼ばれた。**ルートに1回だけ宣言すると、
   `isRoot: true` の1つの呼び出しになる**（`project.vitest.projects` から
   子 project 一覧とその `config.maxWorkers` を読める——2つの project それぞれの
   解決後の `maxWorkers` を1回の呼び出しから正しく読めた: `parallel` → 2、
   `serial` → 1）。⟹ **ルートに1回だけ宣言する形を採った**——project ごとに
   宣言すると、この ADR が作る TEMPLATE 元 DB の migrate とクローンが
   （後述の「踏んだ壊れ方」1件目とは別の経路で）競合しうる。

3. **`VITEST_POOL_ID` は 1..maxWorkers の範囲で、group が変わると作り直される**【実測】。
   `parallel`（maxWorkers 2）のテストでは `1`/`2`、`serial`（maxWorkers 1）のテストでは
   常に `1` が観測された——`serial` project は `parallel` project の worker と
   同じ ID 空間を再利用するが、時間的に重ならないので DB 名を使い回しても壊れない
   （それでも、この ADR は `serial` 側に別名 `_serial` を与えた。理由は下の
   「踏んだ壊れ方」2件目）。

4. **`test.env` は `setupFiles`/テスト本体の `process.env` に反映される**【実測】。
   `serial` project に `env: { MNEMORA_WORKER_DB_SUFFIX: "serial" }` を設定すると、
   その project のテストからだけ `process.env.MNEMORA_WORKER_DB_SUFFIX` が読めた。

**⟹ 4点とも期待どおりだったので、実装を止めずに進めた。**

---

## 実装中に踏んだ壊れ方（2件、どちらも実装を直して塞いだ）

1. **`project.config.maxWorkers` は、明示していないと `undefined` のまま**【実測、
   2026-09-29、48コアの手元環境】。`maxWorkers` を config で明示せず vitest の
   自動解決に任せると、`project.config.maxWorkers` は `globalSetup` の時点では
   `undefined` のままで（実際の worker 数は実行時に別の内部関数が計算し、
   `project.config` へは書き戻さない）、`globalSetup` の「見つからなければ 1 に倒す」
   フォールバックが静かに発動して worker DB を1個しか作らなかった。48コアの
   手元環境では実際の worker 数が最大47まで上がり、`w3`・`w7`・`w9` …
   （存在しない DB 名）への接続が `error: database "mnemora_test_w3" does not exist`
   で落ちた（`Test Files 172 failed | 38 passed (210)`）。
   ⟹ **直し方**: `resolveDefaultMaxWorkers()`（`worker-database.ts`。vitest 自身の
   既定式 `Math.max(os.availableParallelism() - 1, 1)` と同じもの——ソースを読んで
   確認した）を `vitest.config.mts` の並列 project の `maxWorkers` に明示的に固定する。
   これで `project.config.maxWorkers` は必ず数値になり、`globalSetup` は
   「見つからない／数値でない」ときに黙って 1 へ倒さず例外にした（同じ壊れ方を
   再発したときに、また「DB が無い」という分かりにくいエラーへ倒れないように）。

2. **`DATABASE_URL` が根本的に届かないとき、`globalSetup` が vitest 全体を1発で
   落としてしまい、`scripts/__tests__/run-db-tests.test.mjs` の歯が赤くなった**
   【実測】。`scripts/run-db-tests.mjs`（ADR 0016）は「DB テストが落ちるとき、
   門が赤くなり、かつ vitest 自身の `Test Files N failed` という要約が出る」ことを
   縛っている。届かない `DATABASE_URL`（`postgresql://postgres:postgres@127.0.0.1:1/…`）
   で試したところ、この ADR の `globalSetup` が base DB への migrate 接続の
   `ECONNREFUSED` をそのまま投げ、vitest がファイル収集を始める前に落ちるため、
   出力が `No test files found, exiting with code 1` になり、`Test Files N failed`
   という要約が一切出なくなっていた。⟹ **直し方**: `globalSetup` が base DB への
   接続で `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`ENETUNREACH`
   （`isDatabaseUnreachableError`、`worker-database.ts`）を受け取ったときは、
   worker DB を作らずに no-op の teardown を返して抜ける——各テストファイル自身の
   `getTestClient()`/`requireDatabaseUrl()` 経由の接続が、これまでどおり個別に
   失敗し、`Test Files N failed` の形が保たれる。**それ以外の理由（migration の
   SQL エラー等）による失敗は、これまでどおり `globalSetup` の時点で即座に
   例外にして止める**——接続できているのに黙って個別失敗へ委ねると、210ファイル
   それぞれが「DB が無い」という分かりにくいエラーを吐くだけの状態になり、
   本当の原因（migration の壊れ）が埋もれる。

---

## advisory lock がデータベースごとに分かれるかの実測

**「DB ごと」を選べる前提**は、advisory lock がデータベース単位で分かれることに
懸かっている（クラスタ全体で共有されるなら、advisory lock を使うファイルは
DB を分けても直列にする必要が残る）。

**【実測】2026-09-29、手元の PostgreSQL 17（`initdb` で自分専用に構築、
`packages/postgres/AGENTS.md` の手順）で確認した。**

同じクラスタに2つの DB（`advtest_a` / `advtest_b`）を作り、同じ数値キー
（session-level: `424242`、xact-level: `555555`）で `pg_advisory_lock` /
`pg_try_advisory_lock`（session・xact 両方）を試した。

```
-- session-level（pg_advisory_lock / pg_try_advisory_lock）
psql -d advtest_a -c "SELECT pg_advisory_lock(424242); SELECT pg_sleep(4);"  -- 保持する側（バックグラウンド）
psql -d advtest_b -c "SELECT pg_try_advisory_lock(424242) AS got_it_in_db_b;"  -- => t（別 DB からは取れる）
psql -d advtest_a -c "SELECT pg_try_advisory_lock(424242) AS got_it_in_db_a;"  -- => f（同じ DB からは取れない・対照）

-- xact-level（pg_advisory_xact_lock / pg_try_advisory_xact_lock）
psql -d advtest_a -c "BEGIN; SELECT pg_advisory_xact_lock(555555); SELECT pg_sleep(4); COMMIT;"  -- 保持する側
psql -d advtest_b -c "BEGIN; SELECT pg_try_advisory_xact_lock(555555) AS got_it_in_db_b; COMMIT;"  -- => t
psql -d advtest_a -c "BEGIN; SELECT pg_try_advisory_xact_lock(555555) AS got_it_in_db_a; COMMIT;"  -- => f（対照）
```

**結果: session-level・xact-level のどちらも、advisory lock はデータベースごとに
分かれる**（別 DB からは常に取れる = `t`。**同じ DB からの対照が確実に `f` になる
ことも確認した**——探り棒が生きていることの陽性対照、`AGENTS.md`「『出なかった』を、
事象が無いことの証明にしない」に対応する）。

⟹ **advisory lock を使うファイル（`grep -il advisory` に当たる約20ファイル）は、
DB ごとに分ければそれだけで安全になる。直列の群に追加で回す必要は無い。**
（もし分かれていなかった場合は、この ADR は直列の群に advisory 系ファイルも
含めていたはずだが、実測どおり分かれていたので含めていない。）

**`CREATE DATABASE … TEMPLATE` が通ることも確認した**【実測】——`CREATE DATABASE
mnemora_test_w1 TEMPLATE mnemora_test;` を実行し、拡張（`vector`/`btree_gin`/
`pgcrypto`）がクローン先にも入っていることを `\dx` で確認した。

---

## 直列の群（16ファイル）

**Issue #1277 は「15本」と書いていたが、`SERIAL_TEST_FILES` を作るために改めて
`grep` で数え直したところ、重複を除いた実際の一覧は 16ファイルだった**
（AGENTS.md「無かったと書く前に、探した場所を列挙する」に対応し、探した語を
下に列挙する）。

`pg_stat_activity` / `pg_terminate_backend` / `pg_locks` / `CREATE ROLE` の4語で
`packages/postgres/src/__tests__/*.test.ts` を `grep` した和集合が、下の16ファイルと
一致する【実測・2026-09-29】:

| ファイル | 当たった語 |
|---|---|
| `archive-decayed-concurrency.postgres.test.ts` | `pg_stat_activity` |
| `db-transaction-connection-loss.test.ts` | `pg_stat_activity` / `pg_terminate_backend` |
| `drizzle-pool-proxy.test.ts` | `pg_stat_activity` / `pg_terminate_backend` |
| `migrate-connection-loss.test.ts` | `pg_stat_activity` / `pg_terminate_backend` / `pg_locks` |
| `outbox-claim-statement-failure-recovery.postgres.test.ts` | `pg_terminate_backend` |
| `pool-error-warning-guard.postgres.test.ts` | `pg_stat_activity` / `pg_terminate_backend` |
| `pool-idle-connection-loss.test.ts` | `pg_stat_activity` / `pg_terminate_backend` |
| `purge-expired-events-by-retention-concurrency.postgres.test.ts` | `pg_stat_activity` |
| `restore-superseded-concurrent-forget.postgres.test.ts` | `pg_stat_activity` |
| `scale-bench-close-on-throw.postgres.test.ts` | `pg_stat_activity` |
| `temp-database.test.ts` | `pg_stat_activity`（`temp-database.ts` 本体が使う） |
| `analyze-memories-lock.postgres.test.ts` | `pg_locks` |
| `advisory-lock-cleanup.postgres.test.ts` | `pg_locks` |
| `extension-mode.postgres.test.ts` | `CREATE ROLE` |
| `migrate-concurrency.test.ts` | `CREATE ROLE` |
| `vector-space-concurrency.test.ts` | `CREATE ROLE` |

理由: `pg_stat_activity`/`pg_terminate_backend` は `datname` で絞らず `query ILIKE`
で pid を探すものが多く、DB を分けても他 worker の接続を巻き込みうる。`pg_locks`
はクラスタ全体の行が見える。`CREATE ROLE` はクラスタ全体のオブジェクト（DB に
属さない）——DB を分けても互いに見える・衝突しうる。

**この16ファイルは `vitest.config.mts` で `fileParallelism: false` の別 project
（`postgres-db-serial`）に置き、`sequence.groupOrder: 1` で並列 project の後に
（重ならずに）走らせる。**

**この一覧は網羅の証明ではない**——`grep` は今の4語に当たるものだけを拾う。
将来同種のファイルを足すときは、同じ4語（と、クラスタ全体に効く操作全般）を
意識すること。

---

## 採らなかった案: ファイルごとのスキーマ

Issue #1277 が挙げたもう1案（1つの DB のまま、ファイルごとに専用スキーマへ
migrate する）は採らなかった。

- **拡張は DB に1つしか置けない**。[#1256](https://github.com/takecchi/mnemora/issues/1256) /
  [ADR 0366](./0366-trigram-extension-follows-vector-schema.md) が実際に踏んだ壊れ方
  ——2つ目以降の名前空間で `pg_trgm` を使おうとすると、素の例外（`42883`）で落ちる。
  DB ごとに分ければ、この問題はそもそも発生しない（各 DB が自分専用の拡張を持つ）。
- **[ADR 0331](./0331-extension-creation-shared-advisory-lock.md) の「拡張を作る段」の
  共有 advisory lock**（schema に依らない固定キー）は、スキーマを分けても直列化の
  対象が変わらない——スキーマが違っても同じ DB では同じキーを取り合う。DB ごとに
  分ければ、advisory lock の名前空間そのものが DB ごとに分かれる（上の実測）ので、
  この直列化の影響を受けない。
- 索引の `DROP`/`CREATE`・`pg_stat_*` を見る歯は、スキーマを分けても DB 全体・
  クラスタ全体に及ぶものがあり、Issue #1277 の起票自体が「互いに見える／効く」と
  指摘していた。DB ごとに分ければ、この種の可視性の問題も避けられる。

**DB ごとの案は、1つの DB のまま3つの懸念を個別に塞ぐより、表・索引・統計・拡張が
DB ごとに物理的に分かれることで、まとめて塞げる。** 引き受ける負債は、worker の数だけ
DB を作る／落とすコスト（実測は下）。

---

## [ADR 0016](./0016-db-test-gate-explicit-exclusion.md) / `run-db-tests.mjs` との関係

ADR 0016 は「専用データベースは採らなかった」と書いているが、**層が違う**。
ADR 0016 が扱うのは **`packages/postgres` と `examples/chat` という別パッケージが
同じ DB を共有して同時に `test:db` を実行したときの排他**（`run-db-tests.mjs` が
1パッケージずつ直列に呼ぶ）。この ADR（0371）が扱うのは **`packages/postgres`
**単体**の `test:db` の中で、vitest の worker（同一プロセス群）がファイルを
並列に処理するときの排他**。ADR 0016 の「専用 DB は過剰」という判断は
パッケージ間の話であり、`run-db-tests.mjs` は変えていない（`packages/postgres`
の `test:db` は相変わらず1回の `pnpm --filter @mnemora/postgres run test:db` 呼び出し
のままで、`examples/chat` とは ADR 0016 の直列のまま）。この ADR は、その1回の
呼び出しの**内側**を並列にしただけである。

---

## 前後の所要時間

**CI（4 vCPU の `ubuntu-latest`、main の直近3run。ジョブの `startedAt`→`completedAt`）**:

| run | UTF8 | SQL_ASCII |
|---|---|---|
| 36555862174 | 493s | 384s |
| 36554760638 | 473s | 462s |
| 36551045171 | 461s | 449s |

**この PR の CI の実測は未計測**（push 後、CI の完了を待たずにこの ADR を書いている。
`gh pr checks` の結果は PR 本文に載せる）。

**手元（【実測】2026-09-29。他のテナントと同じ器を共有しており、絶対値は器の負荷で
大きく変わる——同じ条件で前後を測った相対比較として読むこと）**:

| 設定 | Test Files | Tests | Duration |
|---|---|---|---|
| 改変前（main、`fileParallelism: false`、直列） | 210 passed | 1934 passed | **848.55s** |
| 改変後（並列 project + 直列 project、`--maxWorkers=8`、1回目） | 210 passed | 1934 passed | 226.22s |
| 改変後（同上、2回目） | 210 passed | 1934 passed | 218.44s |
| 改変後（同上、3回目） | 210 passed | 1934 passed | 217.33s |
| 改変後（同上、4回目。接続不可耐性の直し込み後） | 210 passed | 1934 passed | 195.99s |
| 改変後（`origin/main` 併合後、213ファイルに増加） | 213 passed | 1985 passed | 181.12s |
| 改変後（`--sequence.shuffle` 併用） | 209 passed / **1 failed**（下記） | 1932 passed / **2 failed** | 227.99s |

**テスト件数**: 改変前後で同じコミット時点なら同じ（210ファイル/1934件、
`origin/main` 併合後は213ファイル/1985件——並列化とは無関係に main 側で
3ファイル増えた分）。**テストの主張（expect・it の中身）は1つも変えていない**
（変えたのは `pool-error-warning-guard.postgres.test.ts` の
`setupFilesOf`——vitest.config.mts が project 構成になったことで `setupFiles` の
在り処が変わったのを追随させただけで、アサーションの中身・件数は変えていない）。

**48コアの手元環境では `maxWorkers` を自動解決に任せると最大47 worker まで
上がり、CREATE DATABASE 47個・DB 接続の輻輳で個別テストが `testTimeout`
（30秒）に達することがあった**【実測】——`--maxWorkers=8` に絞ると解消した
（同じ48コア環境で8 workerでも47 workerとほぼ同じ Duration だった: 226s
vs 232s。**worker を増やすほど速くなるわけではない**、I/O 律速と見られる)。
**CI は4 vCPU なので `maxWorkers` は3に解決され、この手元の輻輳は再現しない**
——`resolveDefaultMaxWorkers()` の式（`os.availableParallelism() - 1`）は
CI・手元のどちらでも同じ式で、環境ごとに違う値を出す。

---

## `--sequence.shuffle` で見つかった、この PR とは無関係な既存の壊れ方

**`--sequence.shuffle` を付けた回だけ、`upgrade-from-released.postgres.test.ts` が
2件落ちた**（`migration の前後で既存の記憶の行が変わらない` / 関連1件）。

**調査した結果、この PR（ファイル並列化）とは無関係の、既存の bug だと判断した**
【実測・2026-09-29】:

- 同じファイルだけを対象に `vitest run --sequence.shuffle` を4回（違う seed）
  走らせたところ、**単体（他のファイルと無関係、worker 1個）でも4回とも同じ形で
  落ちた**。
- **`origin/main` のオリジナルの `vitest.config.mts`（このブランチの変更を一切
  含まない、`fileParallelism: false` の単一 project）に戻して同じ1ファイルを
  `--sequence.shuffle` で走らせても、同じ形で落ちた。**

原因は、このファイルの `it()` が宣言順に依存している（暗黙の前提）こと:
「migration の前後で既存の記憶の行が変わらない」が `beforeAll` で取った
スナップショットと後で読んだ行を比較する一方、同じ `describe` の中の別の `it()`
（「残っていた embed ジョブを tick が消化し、新しい記憶を observe → tick →
recall で引ける」）が `observe()` で新しい記憶を書き込む。宣言順（このファイルが
前提にしている順）ならスナップショット比較が先に終わるが、`--sequence.shuffle`
は同じファイル内の `it()` の順序も入れ替えるため、書き込みが先に走ると
スナップショット比較が食い違う。

**この PR では直さない**——Issue #1277 の範囲は「ファイル並列化」であり、
このファイル自体の `it()` 順序依存は別の話である。オーナー／マネージャーへの
報告に、別 issue 化を検討する材料として書く。**直列の群への追加でも塞がらない**
——単体実行でも壊れることを確認済みなので、他ファイルとの DB 共有が原因ではない。

---

## 直した既存の歯・文書

- **`scripts/__tests__/run-db-tests.test.mjs`**「DATABASE_URL が在って DB テストが
  落ちるとき: 門が赤くなる」: 上の「踏んだ壊れ方」2件目のとおり、`globalSetup` が
  接続不可を検知したら worker DB を作らず抜けるようにして直した（テスト自体は
  変えていない）。
- **`packages/postgres/src/__tests__/pool-error-warning-guard.postgres.test.ts`**
  「packages/postgres の vitest.config.mts の setupFiles に守りが載っている」:
  `setupFilesOf()` が `test.setupFiles`（トップレベル）しか見ておらず、
  `test.projects[].test.setupFiles`（この PR 以降の `packages/postgres` の形）を
  見ていなかったので、両方から集めるように直した。アサーション自体
  （「守りが setupFiles のどこかに載っている」）は変えていない。
- **`packages/postgres/vitest.config.mts` のコメント**: `fileParallelism: false`
  一本だった説明を、並列/直列の2 project に分けた構成の説明に書き換えた。

**`docs/decisions/README.md`（索引）には触っていない**——マージ直前に別途生成する
運用（ADR 0137）。`scripts/__tests__/adr-duplicate-number.test.mjs` は
`docs/decisions/*.md` のファイル名だけを見て索引に依存しないので、この ADR を
足しても赤くならないことを確認した【実測】。

---

## これが覆るとしたら何が起きたときか

- **`vitest` が `test.projects` / `sequence.groupOrder` の意味を変えたとき。**
  この ADR の実装は vitest 5.0.0 の実測に強く依存している——バージョンを上げる
  ときは、上の「vitest 5.0.0 の実測」を取り直すこと。
- **CI の runner の vCPU 数が変わったとき。** `resolveDefaultMaxWorkers()` は
  CPU 数から自動で決まるので、コードの変更なしに追随するはずだが、実測は
  取り直すこと。
- **advisory lock がデータベースごとに分かれるという実測が、将来の PostgreSQL
  バージョンで変わったとき。** 現時点（PostgreSQL 17）の挙動であり、将来変わる
  ことを示す一次情報は無い（PostgreSQL のドキュメントが明記している仕様ではあるが、
  仕様が変わらない保証はここでは主張しない）。

## 確かめていないこと

- **CI 実測の「後」**: この PR の CI がまだ完了していない時点でこの ADR を書いた。
  PR 本文に実測を追記する。
- **48コア以外の環境での worker 数と輻輳の関係**: 手元は48コアの共有環境1つでしか
  測っていない。CI の4 vCPU での実際の worker 数（3）での挙動は、CI の実測が
  出るまで確認できていない。
- **`upgrade-from-released.postgres.test.ts` の `it()` 順序依存を直すかどうか**は
  この ADR の範囲外とし、判断していない。

---

## 追記（2026-09-30）: 「`upgrade-from-released` の順序依存は範囲外」とした件は、解消済み

**上の本文は当時の記録として書き換えない。** 「`--sequence.shuffle` で見つかった、この PR とは無関係な既存の壊れ方」と「確かめていないこと」の末尾で範囲外とした `upgrade-from-released.postgres.test.ts` の `it()` 順序依存は、[Issue #1416](https://github.com/takecchi/mnemora/issues/1416) として起票され、[PR #1418](https://github.com/takecchi/mnemora/pull/1418) で直った（Issue #1416 は閉じている）。

- 直し方（PR #1418 本文）: 比べる「後」の値（migration 直後のスナップショット）も `beforeAll` の中で凍結し、対象の `it()` は凍結した2つの値を `toEqual` で比べるだけにした。比較する列・`toEqual` は変えていない（主張は弱めていない）。
- PR #1418 本文は、修正前の origin/main で `--sequence.shuffle` を付けると seed 3つで 2/19 が赤、修正後は緑と報告している。この追記の書き手は再実行していない。
- 上の本文が述べた原因（同じ `describe` の書き換える `it()` との順序依存であり、ファイル並列化・DB の共有とは無関係）は、PR #1418 の原因の説明と一致している。
