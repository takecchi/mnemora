# ADR 0349: drizzle に渡す Pool を、`connect` だけを包んだ Proxy にして、`db.transaction()` が借りる接続に `error` リスナーを付ける

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

> **案の選択（Proxy で包む）はオーナーの回答である（ask_human 7844da4c、2026-09-28）。**
> 本文と、回答の外に残った細部（callback 形を包まないこと・`bind` のこと・#1213 をこの変更に混ぜないこと）は
> クローン miku の委譲先が書いた。それらはクローン miku の判断であり、オーナーの判断ではない。

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書、`node_modules` の依存を書き手が読んで確かめた。
- **【実測】** — この書き手が手元の Postgres 17 + pgvector で `vitest` を走らせて確かめた。

---

## 問い

`@mnemora/postgres` のストアが `db.transaction()`（drizzle-orm）を実行している最中に DB 側で接続が切れたとき、
Node のプロセスごと落ちないようにするには、どこに `error` リスナーを付けるか（[Issue #868](https://github.com/takecchi/mnemora/issues/868)）。

## 【現物】壊れ方

- drizzle-orm@0.45.2 の `NodePgSession.transaction`（`node-postgres/session.js`）は、`this.client.connect()` で接続を借り、
  `finally` で `release()` する。借りた接続に `error` リスナーは付けない。
- pg-pool@3.14.0 は、`_acquireClient` で接続を渡す直前に自分の idle 用リスナーを外す（`client.removeListener('error', idleListener)`）。
  ⟹ トランザクションの最中は、借りた接続にリスナーが1つも無い。切れると `error` がそのまま投げられ、uncaught exception になる。
- `packages/postgres/src` の `db.transaction()` は、すべて `createPostgresClient` が作った `db` を通る。
  （**何か所あるかはここに写さない**（ADR 0234）。`git grep -n "\.transaction(" -- packages/postgres/src` を引くこと。）

## 決めたこと

### 1. drizzle には `new Proxy(pool, …)` を渡し、`connect` だけを差し替える

- `connect()`（promise 形）は、本物の `pool.connect()` で借りた接続に、何もしないリスナー（モジュールで1つの関数参照）を付け、
  `client.release` を包んで、返すときに外してから本物の `release` を呼ぶ。pg-pool は借りるたびに `client.release` を付け直すので、
  包んだ `release` はその1回の貸し出しにしか効かない。
- 実際のエラーは、進行中のクエリの reject として呼び出し側へ届く（ADR 0339 と同じ考え方）。
- `connect` 以外のプロパティは、本物の `pool` からその都度読み、関数なら本物の `pool` に束縛して返す。
  `instanceof Pool` とプロトタイプ鎖はトラップしないので、本物に委ねる。drizzle は `instanceof Pool` で pool かどうかを見ている。
- callback 形の `connect(cb)` は包まずに本物へ渡す。drizzle は promise 形しか使わない【現物】。

### 2. 公開する `client.pool` は書き換えない

利用者が `client.pool.connect()` で借りた接続には、mnemora のリスナーは付かない。
ADR 0339 と同じく、**mnemora が自分で借りたものにだけ付ける。** `public-pool-connect-unwrapped.test.ts` が縛る。

### 3. `db.$client === client.pool` は `false` になる。これを振る舞いの変化として CHANGELOG に書く

- `$client` は drizzle が実行時に生やす欄で、公開の型 `Db`（`NodePgDatabase<typeof schema>`）には載っていない【現物】。
  ⟹ `.d.ts` は変わらず、公開 API の門（ADR 0178）は拾わない。拾わないからこそ、CHANGELOG `[1.1.0]` の Fixed に書いた。
- `db.$client` の `instanceof Pool`・`totalCount`・`on`・`end()` は、本物の pool に届く【実測】（`drizzle-pool-proxy.test.ts`）。
- repo の中で `$client` を使っている箇所は無かった【現物】。

### 4. [Issue #1213](https://github.com/takecchi/mnemora/issues/1213)（公開の pool に `error` リスナーが無い）は、この変更に混ぜない

#1213 の案3（`createPostgresClient` が公開の `pool` に `on("error")` を付ける）は、決定2の区別を崩す側にある。
また、その採否はまだ誰も決めていない。⟹ #1213 は開いたまま残し、README の「利用者が付ける」はそのままにした。

## 採らなかった案

- **公開する `pool` の `connect` を差し替える**（閉じた PR #863 の初稿）: 利用者が自分で借りた接続にも黙ってリスナーが付く。決定2に反する。
- **`Object.create(Pool.prototype)` で作った包みを渡す**（PR #863 のやり直し、`78e92f6`）: 実インスタンスの欄を持たないため、
  `db.$client.totalCount`・`end()` が例外になった（Issue #868 本文の実測）。
- **12か所前後の `db.transaction()` を、自前の checkout ヘルパに置き換える**（Issue #868 の案B）: 公開面は変わらないが、
  ストアのコンストラクタと呼び出し側、トランザクションの境界を広く書き換えることになる（Issue #868 のコメントの見積もり）。
- **上流（pg@9 の既定リスナー、drizzle-orm）を待つ**（案C）: 時期の見積もりの材料が無い（Issue #868 のコメントの調査）。

## 引き受けた負債

- **`db.$client` の同一性が変わる。**`db.$client === client.pool` に頼る利用者のコードは、`false` を見る。
- **drizzle が `BEGIN` に失敗した場合の接続の漏れは、直していない。**drizzle-orm 0.45.2 は `BEGIN` を `try` の外で打つので、
  `BEGIN` が失敗すると `release()` が呼ばれない（上流の drizzle-orm #6341 など。Issue #868 のコメント）。その場合、
  この変更が付けたリスナーも付いたまま残る。漏れているのは接続そのものであり、リスナーはその上に1本残るだけである。
- **Proxy の `get` は、関数を読むたびに `bind` した新しい関数を返す。**`db.$client.on === db.$client.on` は `false` になる。
  負荷の下での性能への影響は測っていない。
- **`bind` を外しても、今の pg では手元の歯は赤くならなかった**【実測】（下の変異 M6）。書き込みは既定の `set` で本物に届き、
  読み込みも Proxy を通るので、`this` が Proxy でも動く。`bind` は、pg が将来 `#private` の欄を使ったときに備えた守りとして残した。
  ⟹ この守りは、今は歯で縛られていない。

## これが覆るとしたら

- pg が checked-out client に既定のリスナーを付けるようになった（brianc/node-postgres#3630、`pg@9.0`）。
- drizzle-orm が、借りた接続にリスナーを付けるようになった。
- drizzle-orm が `db.$client` を公開の型に載せ、その同一性を約束するようになった。
- 利用者から、`db.$client === client.pool` に頼っているという報告が来た。

## 確かめたこと【実測】

手元の Postgres 17 + pgvector（`initdb --locale=C.UTF-8`）で、次の3本を名前で指定して走らせた。

- `db-transaction-connection-loss.test.ts`（Issue #868 の再現用テスト。枝 `fix/connect-error-listener-sweep` から中身だけを持ち込んだ）
- `public-pool-connect-unwrapped.test.ts`（同じく持ち込んだ）
- `drizzle-pool-proxy.test.ts`（新規）
  - `db.$client` の面
  - commit と rollback を30回繰り返したあとに、同じ物理接続にリスナーが残らないこと
  - 切れたあとの次の呼び出しが通ること

修正前の形（main の `client.ts`）では、`Uncaught Exception: Error: Connection terminated unexpectedly`（vitest の Errors 1）と
`db.$client === pool` の検査で赤になった。修正後は5件とも緑になった。

変異（`client.ts` に1つずつ当て、元に戻して緑を確かめた）:

| # | 変異 | 結果 |
|---|---|---|
| M1 | 借りた接続にリスナーを付けない | 赤（Uncaught Exception） |
| M2 | `release` でリスナーを外さない | 赤（リスナーが残る） |
| M3 | 包んだ `release` が本物を呼ばない | 赤（2件） |
| M4 | やりすぎ: 公開する `pool` も Proxy にする | 赤（`public-pool-connect-unwrapped` ほか） |
| M5 | やりすぎ: 公開する `pool` に `on("error")` を付ける（#1213 の案3） | 赤（`db.$client` の面） |
| M6 | 関数を `bind` しない | **緑のまま**（上の「引き受けた負債」） |

## 確かめていないこと

- 負荷・多重度の高い本番相当の条件での、Proxy 越しの性能。
- CI のサービスコンテナで、この3本が同じ結果になるか（この ADR を足した PR の CI で確かめる）。
