# ADR 0340: `db.transaction()`（drizzle-orm）が借り切る checked-out client にも、ADR 0339 と同じ空の `error` リスナーを届かせる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-26

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo・依存パッケージのコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`psql`/`pg_ctl` 等を走らせて確かめた。

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
| `packages/postgres/src/client.ts:65`（`new Pool(...)` 自体） | 本番 | — | `Pool` の生成のみ。`pool.connect()` はここでは呼ばない |

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

`await this.client.connect()`（`this.client` は `createPostgresClient` が渡した
`Pool` インスタンスそのもの）で checked-out client を借り、`finally` で
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
先に書き、**対策前のコードに対して実行し赤いことを確認した**:

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

## 決めたこと

1. **`drizzle-orm` は node_modules の依存であり、直接編集できない。** 代わりに、
   `db.transaction()` が使う `Pool` インスタンスを作る唯一の入口
   （`client.ts` の `createPostgresClient` の doc コメントが既にそう呼んでいる）で、
   `Pool` を作った直後にその**インスタンス自身**の `connect` メソッドを、
   返す checked-out client へ ADR 0339 と同じ no-op `error` リスナーを
   自動で付け外しするものへ差し替える（`protectCheckedOutClientsFromUnhandledErrors`、
   `client.ts`）。`drizzle()` にも呼び出し側にも、以後は今日と同じ `Pool` に見える
   ——公開の型・export は増やしていない（`createPostgresClient` の引数・返り値は
   1バイトも変わっていない）。
2. **`pool.connect()` の promise 形だけを対象にする。** callback 形
   （`pool.connect((err, client, done) => ...)`）はこのコードベースのどこからも
   （`migrate.ts`/`advisory-lock.ts`/drizzle-orm のいずれからも）呼ばれていない
   ——渡ってきたら対策せずそのまま元の実装へ委譲する。
3. **`migrate.ts`/`advisory-lock.ts` 自身の ADR 0339 の対策はそのまま残す
   （削らない）。** `runMigrations`/`acquireAdvisoryLock` がこの `Pool` を
   受け取って呼ばれる経路（`test-db.ts` の `getTestClient()` が実際にそう
   している）では、同じ checked-out client に2つの no-op リスナー
   （別の関数参照）が付くことになるが、`EventEmitter` は同じイベントに
   複数のリスナーを同時に持てるため害は無い——どちらも自分の
   `release()`/`removeListener` の対で正しく外れる（積み上がらない）ことを
   `migrate-connection-loss.test.ts`（2 tests）・
   `conformance.postgres.test.ts`（376 tests）を再実行して確認した。

## 副次的に対策される範囲

`createPostgresClient` が返す `Pool` は `MemoryStore`/`VectorStore`/
`TrigramLexicalStore` の `db.transaction()` だけでなく、同じ `pool` を
直接受け取って `pool.connect()` を呼ぶ任意のコード（`examples/chat/src/bench/*`
に実例がある——`association-scale-nondeterminism.ts`・`association-scale-bench.ts`
がベンチの中で `pool.connect()` を使っている）にも及ぶ。**これは意図した
副次効果であり、`Pool` インスタンス単位の対策であるという設計の性質から
自然に生じる**——個別に対策を追加していない。

## 検討して採らなかった案

- **`pool.on('error', () => {})` を `Pool` 自体に付ける**: [ADR 0020](./0020-temp-database-drain-before-drop.md)
  と ADR 0339 が既に却下した案であり、ここでも却下する。理由は同じ——
  `Pool` 全体を黙らせる話ではなく、checked-out client 単位で意図した経路
  （`db.transaction()` の `catch`/`finally`）へ倒すのが目的。
- **`memory-store.ts`/`vector-store.ts`/`trigram-lexical-store.ts` の
  各 `db.transaction()` 呼び出しを、`pool.connect()` を自前で呼ぶ
  独自のトランザクションヘルパへ置き換える**: 却下——十数箇所の
  トランザクション境界を書き換える必要があり、ビジネスロジックそのものに
  手を入れるリスクが、ADR 0339 と同じ形の対策を1箇所（`client.ts`）に
  閉じ込める案に比べて著しく大きい。`Pool` インスタンス単位で対策できる
  以上、個々の呼び出し側を触る理由が無い。

## 引き受けた負債

- **`pool.connect` のメソッド差し替えは、`pg`/`drizzle-orm` の将来のバージョンで
  `Pool.connect` の内部呼び出し規約が変わると追随が壊れる可能性がある。**
  ADR 0339 の「確かめていないこと」と同じ性質の負債であり、`pg@8.23.0`・
  `drizzle-orm@0.45.2` での実測に基づく。
- **`createPostgresClient` を経由しない `Pool`**（`bin/migrate.ts` が
  `new Pool({ connectionString })` を直接作る経路、`examples/chat` の一部の
  script が同様に直接 `Pool` を作る経路——本 ADR の対象調査では確認していない）
  には、この対策は届かない。`runMigrations`/`acquireAdvisoryLock` 自身は
  ADR 0339 の対策を個別に持つため実害は無いが、**それ以外の直接
  `pool.connect()` を呼ぶコード**がもしあれば、`createPostgresClient` を
  経由しない限り引き続き無防備である。

## 確かめていないこと

- **`examples/chat`・`packages/bullmq` に `createPostgresClient` を経由しない
  独自の `new Pool(...)`/`new Client(...)` があるか**は `grep -rn "new Pool(\|new
  Client(" examples/ packages/bullmq/src` で調査し、ヒットが無いことを確認した
  ——**この grep の射程でヒットしなかった、ということだけを確認した**。
  動的に構築する経路（文字列結合・`require`/`import()` の遅延評価等）がもし
  あれば、この grep では見えない。
- **本番相当の負荷の下で、`pool.connect` の差し替え自体が性能に影響するか**
  は測っていない（ADR 0339 と同じ判断——追加されるのは関数呼び出し1段と
  リスナーの付け外しのみで、実測の必要は薄いと判断した）。
- **`drizzle-orm` の将来のバージョンが `NodePgSession.transaction` の実装を
  変えた場合**（例えば checked-out client を使わない形に変わる、または
  自前で `error` リスナーを付けるようになる）に、この対策がそのまま
  有効かは検証していない。
