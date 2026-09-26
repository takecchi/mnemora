# ADR 0340: `db.transaction()`（drizzle-orm）が借り切る checked-out client にも、ADR 0339 と同じ空の `error` リスナーを届かせる——ただし公開する `Pool` は書き換えない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-26

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo・依存パッケージのコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`psql`/`pg_ctl`/`node` 等を走らせて確かめた。

---

## 問い

[ADR 0339](./0339-checked-out-client-error-listener.md) は `runMigrations`/
`acquireAdvisoryLock`（`migrate.ts`/`advisory-lock.ts`）**自身**が呼ぶ
`pool.connect()` に、借りたクライアントへの `error` リスナー欠如
（`pg` の仕様上、checked-out client の接続断は呼び出し側が自分で拾わないと
Node の `EventEmitter` の既定動作でプロセス全体が uncaught exception で落ちる）
を対策した。**この2箇所以外に、`packages/` の中で同じ形の穴が無いかを掃引した。**

## 【現物】掃引した範囲と結果

`packages/` 配下で `pool.connect()` / `new Client()` / `new Pool()` を
grep し、`__tests__/` と `bench/` を除いた本番コードで見つかったのは次の3箇所
だけだった。

| ファイル:行 | 種別 | `error` リスナー | 判定 |
|---|---|---|---|
| `packages/postgres/src/migrate.ts:687` | 本番 | 有り（ADR 0339） | 対策済み |
| `packages/postgres/src/advisory-lock.ts:104` | 本番 | 有り（ADR 0339） | 対策済み |
| `packages/postgres/src/client.ts`（`new Pool(...)` 自体） | 本番 | — | `Pool` の生成のみ。`pool.connect()` はここでは呼ばない |

**この3箇所だけを見た範囲では、ADR 0339 が塞いだ穴は残っていなかった。**

## 【現物】見つけた別の穴 —— `db.transaction()` が同じ形で `pool.connect()` を呼ぶ

だが `packages/postgres/src/memory-store.ts`・`vector-store.ts`・
`trigram-lexical-store.ts` は、複数文をまとめる箇所で drizzle-orm の
`this.db.transaction(async (tx) => { ... })` を広く使っている（`memory-store.ts`
だけで9箇所）。**この `db.transaction()` の内部実装が、`migrate.ts`/
`advisory-lock.ts` と全く同じ形で `pool.connect()` を呼んでいる**ことを、
依存パッケージのソースを読んで確認した:

`node_modules/drizzle-orm/node-postgres/session.js` の `NodePgSession.transaction`:

```js
async transaction(transaction, config) {
  const isPool = this.client instanceof Pool || ...;
  const session = isPool ? new NodePgSession(await this.client.connect(), ...) : this;
  ...
  try {
    const result = await transaction(tx);
    await tx.execute(sql`commit`);
    return result;
  } catch (error) {
    await tx.execute(sql`rollback`);
    throw error;
  } finally {
    if (isPool) session.client.release();
  }
}
```

`await this.client.connect()`（`this.client` は `createPostgresClient` が
`drizzle()` に渡したオブジェクト）で checked-out client を借り、`finally` で
`release()` する——**だが `error` リスナーは一度も付けない。** `pg-pool`
（`node_modules/pg-pool/index.js:344`）は、`pool.connect()` が client を
呼び出し側へ渡す直前に、pool 自身が持っていた idle 用の `error` リスナーを
`removeListener` する（`pool.query()` が使う内部専用の経路（同ファイル
`464`〜`469` 行、`client.once('error', onError)`）とは別で、`pool.connect()`
で返す client にはリスナーが1つも無い状態になる）。ADR 0339 が引用した
`pg` の要求（「checked-out client の接続断は、借りた側が自分で `error` を
拾うこと」）は、この経路にも同じ強さで掛かる。

## 【実測】陽性対照 —— `pg_terminate_backend` で実際にプロセスを落とす形を再現した

`db.transaction()` を直接叩き、トランザクション本体の実行中に
`pg_terminate_backend` で接続を強制終了する歯
（`packages/postgres/src/__tests__/db-transaction-connection-loss.test.ts`）を
先に書き、**対策前のコード（`main` の `client.ts`）に対して実行し赤いことを
確認した**:

```
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
Vitest caught 1 unhandled error during the test run.
⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: Connection terminated unexpectedly
 ❯ Connection.<anonymous> .../pg/lib/client.js:204:73
 ...
 Test Files  1 passed (1)
      Tests  1 passed (1)
     Errors  1 error
```

`migrate-connection-loss.test.ts` が観測したのと同じ形——「テスト自体は
`rejects.toThrow()` を満たして green に見えるが、`vitest` が別途
uncaught exception を報告する」——であり、実運用のプロセス（`vitest` の
ような catch-all を持たない）では、これがそのままプロセスクラッシュになる。

## 最初の実装（PR #863 初稿）とやり直した理由

**最初の実装は、`createPostgresClient` が公開する `Pool` インスタンス自身の
`connect` メソッドを、生成直後にその場で差し替えるものだった。** これは
`db-transaction-connection-loss.test.ts` を green にする点では機能したが、
クローン miku から次の指摘を受けてやり直した:

> 公開する `pool` の `connect` メソッドを差し替えている。これだと、利用者が
> 自分で `client.pool.connect()` で借りたクライアントにも、黙ってリスナーが
> 付く。これは公開オブジェクトの振る舞いを変えることで、「約束の意味を
> 新しく決める」側に寄っている。ADR 0339 の区別（自分たちが借りたものだけに
> 付ける）を保ちたい。

**この指摘は正しい。** `PostgresClient.pool` は公開している面であり、その
`connect()` が何をするかは mnemora が独自に決めてよい契約ではない。ADR 0339
の対策（`migrate.ts`/`advisory-lock.ts` **自身**が借りたものだけに付ける）と
同じ線を、ここでも保つ必要がある——**mnemora 自身が内部で使うために借りる
もの（drizzle の `db.transaction()` が借りるもの）にだけ付け、利用者が自分で
借りたものには触らない。**

⟹ **`createPostgresClient` が返す `pool` は素の `new Pool(...)` のまま一切
書き換えない。`drizzle()` には、`connect()` だけを安全にした薄い包み
（{@link createDrizzleClientFacade}、`client.ts`）を別途作って渡す。**

## 【実測】包みが drizzle-orm と噛み合うことを確かめた

`packages/postgres` に一時的なスクリプトを置き、本物の Postgres（手元の
`initdb` インスタンス）に対して実行して確かめた（実行後は削除し、repo には
残していない）。

1. **`instanceof` 判定**: `Object.create(Pool.prototype)` で作った包みは
   `facade instanceof Pool` が `true`。`Object.getPrototypeOf(facade).constructor.name`
   は `"BoundPool"`（`pg@8.23.0` が実際にエクスポートしている `Pool` の内部名——
   `NodePgSession.transaction` の緩い代替判定 `.constructor.name.includes("Pool")`
   にも掛かる）。`NodePgSession.transaction` の `isPool` 判定を実際に通ることを
   確認した。
2. **`this` の受け渡し**: 包みに `Pool.prototype` のメソッドを**継承させたまま**
   `this = facade` で呼ぶと、`pg-pool` の `query()`/`connect()` の実装が読む
   `this.log`/`this.Promise` 等（コンストラクタで実インスタンスにだけ設定される
   プロパティ）が無く壊れることを確認した——**この失敗を実際に踏んだ上で**、
   `query`/`connect` を包みの own property として `.bind(pool)` した関数に
   明示的に置き換える設計にした。
3. **query**: `db.execute(sql\`SELECT 1\`)` が包み経由で正しく動く
   （`facade.query = pool.query.bind(pool)` が実 `pool` の `query()` を呼ぶ）。
4. **`db.transaction()` の commit**: `CREATE TEMP TABLE` → `INSERT` を
   トランザクション内で実行し、commit 後に行が残ることを確認した。
5. **`db.transaction()` の rollback**: トランザクション内で例外を投げ、
   その例外がそのまま呼び出し側に伝播すること（`rollback` が二次失敗で
   上書きしないこと）を確認した。
6. **ネストしたトランザクション（savepoint）**: 外側の `db.transaction()` の
   中で `tx.transaction(...)`（drizzle-orm の savepoint 実装）を呼び、内側だけ
   例外で rollback しても、外側のトランザクション（既に checked-out 済みの
   同じ `client`）が影響を受けず、内側で `INSERT` した行だけが残らないことを
   確認した——savepoint は同じ checked-out client 上で完結するため、追加の
   `pool.connect()` は発生しない。
7. **公開する `pool` は無防備なまま**: 包みを介さず `pool.connect()`（実 `pool`
   そのもの）で借りたクライアントの `listenerCount('error')` は `0`
   （素の `new Pool(...)` を直接 `connect()` した場合と同じ）。包み
   （`facade.connect()`）で借りたクライアントは `listenerCount('error')` が
   `1`。**公開する面と、drizzle にだけ見える面とが、実際に別の振る舞いを
   持つことを実測で確認した。**

`typecheck`（`packages/postgres`・`@mnemora/example-chat`・`@mnemora/bullmq`）は
`as Pool`/`as Pool["connect"]`/`as Pool["query"]` の3箇所の型アサーションだけで
通った——`as any` は使っていない。`Object.create(Pool.prototype)` は `pg` が
公開しているクラスのプロトタイプであり、アンダースコア始まりの非公開 API には
依存していない。

## 決めたこと

1. **`createPostgresClient` が公開する `Pool`（`PostgresClient.pool`）は
   一切書き換えない。** `new Pool({ connectionString, ...poolConfig })` を
   作った後、`drizzle()` にはこの `pool` をそのまま渡さず、
   `createDrizzleClientFacade(pool)`（`client.ts`）が作る**専用の薄い包み**を
   渡す。
2. **包みは `query`/`connect` の2つだけを own property として持つ。**
   どちらも元の `pool` インスタンスへ `.bind(pool)` した関数——`this` を
   経由した暗黙の委譲（`Object.create(pool)` のように実インスタンスを
   プロトタイプに積む案）は採らない（上記「測ったこと」2番で実際に壊れる
   ことを確認したため）。`instanceof Pool` を満たすためだけに
   `Object.create(Pool.prototype)`（クラスのプロトタイプ）を使う。
3. **`connect` だけ、返す checked-out client に ADR 0339 と同じ no-op
   `error` リスナーを自動で付け外しする。** `query` はそのまま
   `pool.query.bind(pool)` を素通しする——`pg-pool` の `query()` は内部で
   自前の `error` 保護（`client.once('error', onError)`）を持つため、
   対策が要らない。
4. **`pool.connect()` の promise 形だけを対象にする。** callback 形
   （`pool.connect((err, client, done) => ...)`）はこのコードベースのどこからも
   （`migrate.ts`/`advisory-lock.ts`/drizzle-orm のいずれからも）呼ばれていない
   ——渡ってきたら対策せずそのまま元の実装へ委譲する。
5. **`migrate.ts`/`advisory-lock.ts` 自身の ADR 0339 の対策はそのまま残す
   （削らない）。** `runMigrations`/`acquireAdvisoryLock` は公開する `pool`
   （この包みではない）を受け取って呼ばれる（`test-db.ts` の
   `getTestClient()` が実際にそうしている）ため、ADR 0339 の対策とは別の
   経路であり、互いに干渉しない——`migrate-connection-loss.test.ts`
   （2 tests）・`conformance.postgres.test.ts`（376 tests）を再実行して
   確認した。

## もう副次的には対策されない範囲——前バージョンとの違い

前バージョン（公開する `pool` 自身を書き換える版）は、`examples/chat/src/bench/*`
が `client.pool.connect()` を直接呼ぶ箇所（`association-scale-nondeterminism.ts`・
`association-scale-bench.ts`）にも副次的に保護が及んでいた。**この版では
及ばない**——公開する `pool` は素のままなので、利用者・bench が自分で
`pool.connect()` する経路は今日と同じ、無防備なままである。**これは意図した
差である**（上記「やり直した理由」）。ベンチのこれらの箇所自体は本 ADR・
関連 PR の対象ではない。

## 検討して採らなかった案

- **公開する `Pool` インスタンス自身の `connect` を書き換える**（PR #863 初稿）:
  却下——上記「やり直した理由」。利用者が自分で `client.pool.connect()` で
  借りたクライアントの振る舞いまで変えてしまう。
- **`Object.create(pool)`（実インスタンスをプロトタイプに積む）で包みを作る**:
  却下——`instanceof Pool` は通るが、`query`/`connect` を own property で
  上書きしない限り、継承されたままの `Pool.prototype` のメソッドが
  `this = facade` で呼ばれたときに `this.log`/`this._clients` 等が無く壊れる
  ことを実測で確認した（上記「測ったこと」2番）。今回採った設計
  （own property で明示的に bind）と同じ量のコードが要る上、「継承させて
  いるのに実は使っていない」という誤解を生みやすい。
- **`pool.on('error', () => {})` を `Pool` 自体に付ける**: [ADR 0020](./0020-temp-database-drain-before-drop.md)
  と ADR 0339 が既に却下した案であり、ここでも却下する。理由は同じ——
  `Pool` 全体を黙らせる話ではなく、checked-out client 単位で意図した経路
  （`db.transaction()` の `catch`/`finally`）へ倒すのが目的。
- **`memory-store.ts`/`vector-store.ts`/`trigram-lexical-store.ts` の
  各 `db.transaction()` 呼び出しを、`pool.connect()` を自前で呼ぶ
  独自のトランザクションヘルパへ置き換える**: 却下——十数箇所の
  トランザクション境界を書き換える必要があり、ビジネスロジックそのものに
  手を入れるリスクが、`client.ts` 1箇所に閉じ込める案に比べて著しく大きい。

## 引き受けた負債

- **包みの `query`/`connect` は、`pg`/`drizzle-orm` の将来のバージョンで
  内部呼び出し規約が変わると追随が壊れる可能性がある。** ADR 0339 の
  「確かめていないこと」と同じ性質の負債であり、`pg@8.23.0`・
  `drizzle-orm@0.45.2` での実測に基づく。特に、drizzle-orm が node-postgres
  経路で `client` に対して呼ぶメソッドを増やした場合（例えば将来のバージョンで
  `client.escapeLiteral(...)` のような追加メソッドを使うようになった場合）、
  包みはそれを持たないため壊れる——今回読んだ `session.js` の範囲
  （`query`/`connect`/`instanceof` の3点）でしか動作を保証していない。
- **`createPostgresClient` を経由しない `Pool`**（`bin/migrate.ts` が
  `new Pool({ connectionString })` を直接作る経路）には、この対策は届かない。
  `runMigrations`/`acquireAdvisoryLock` 自身は ADR 0339 の対策を個別に持つ
  ため実害は無い。
- **公開する `pool` を直接 `pool.connect()` する利用者・ベンチのコード**
  （`examples/chat/src/bench/*` に実例がある）は、引き続き無防備である
  （上記「もう副次的には対策されない範囲」）。これは意図した設計の帰結
  ——利用者の `pool.connect()` の振る舞いを mnemora が変えないという約束を
  優先した。

## 確かめていないこと

- **`examples/chat`・`packages/bullmq` に `createPostgresClient` を経由しない
  独自の `new Pool(...)`/`new Client(...)` があるか**は `grep -rn "new Pool(\|new
  Client(" examples/ packages/bullmq/src` で調査し、ヒットが無いことを確認した
  ——**この grep の射程でヒットしなかった、ということだけを確認した**。
  動的に構築する経路（文字列結合・`require`/`import()` の遅延評価等）がもし
  あれば、この grep では見えない。
- **本番相当の負荷の下で、包みを経由する分のオーバーヘッドが性能に影響するか**
  は測っていない（追加は関数呼び出し1段とリスナーの付け外しのみで、実測の
  必要は薄いと判断した）。
- **`drizzle-orm` の将来のバージョンが `NodePgSession.transaction` の実装を
  変えた場合**（例えば checked-out client を使わない形に変わる、`client` に
  対して呼ぶメソッドが増える、または自前で `error` リスナーを付けるように
  なる）に、この対策がそのまま有効かは検証していない。
- **`drizzle-orm` の他のドライバ経路（`node-postgres` 以外）**は対象にしていない
  ——このリポジトリは `drizzle-orm/node-postgres` だけを使っている
  （`client.ts` の import）。
