# ADR 0339: `runMigrations`/`registerEmbeddingSpace` が `pool.connect()` で借り切るクライアントに、空の `error` リスナーを付ける

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-26

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`psql`/`pg_ctl` 等を走らせて確かめた。

---

## 問い

利用者は既存 DB を抱えたまま `mnemora-postgres-migrate`（`runMigrations`）を実行する
（v1.0.0/v1.0.1 が npm に出ている以上、これは仮の話ではない）。**その実行中に DB 側の
接続が失われたら（DB の再起動・フェイルオーバー・運用者による手動切断・OOM kill——
いずれも「マイグレーション中に起きてよいことではない」が「起きないと保証もされていない」
外部要因）、`runMigrations` はどうなるか。**

## 【実測】観測した壊れ方

`packages/postgres/src/migrate.ts` の `runMigrations` は、各マイグレーションファイルの
適用のために `pool.connect()` で checked-out client を借り、`BEGIN` → 本文 → 台帳への
`INSERT` → `COMMIT` を実行し、失敗したら `catch` で `ROLLBACK` して
`Error('migration <file> failed: ...')` を投げる——という契約を doc コメントに明記している。
`packages/postgres/src/advisory-lock.ts` の `acquireAdvisoryLock` も同様に `pool.connect()`
でロック保持用のクライアントを借り、`runMigrations`/`registerEmbeddingSpace` の呼び出し
全体を通じて保持する。

**どちらも、借りたクライアントに `error` リスナーを付けていなかった。** `pg` の
`PoolClient` は `EventEmitter` であり、checked-out（`pool.connect()` で借り切った、
まだ `release()` していない）クライアントの接続が失われると、`pg` はその失敗を
「進行中のクエリがあればそれを reject する」と同時に、クライアント自身にも `error`
イベントとして発火させる。**このイベントに誰もリスナーを付けていないと、Node の
`EventEmitter` は既定動作としてそのまま投げ、プロセス全体が uncaught exception で
落ちる。**

`packages/postgres/src/__tests__/migrate-connection-loss.test.ts` で、手元の Postgres
（`pg_terminate_backend` で checked-out client の裏側のセッションを強制終了する——DB の
再起動やフェイルオーバーが引き起こすのと同じ形の接続断)を使って実測した:

- マイグレーション本体を実行中のクライアント（`migrate.ts`）が死ぬと、`runMigrations`
  が返す Promise は resolve も reject もせず、`vitest` が「Unhandled Errors」として
  uncaught exception を報告する。捕まった場合でも、reject の中身は `catch` が約束する
  `'migration <file> failed: ...'` ではなく、素の `'Connection terminated unexpectedly'`
  だった——`catch` 節の `await client.query('ROLLBACK')` 自体が（接続が死んでいるため）
  失敗し、**元の失敗を上書きしていた。**
- advisory lock 保持用のクライアント（`advisory-lock.ts`）が死ぬと、同じ形で
  uncaught exception になる——このクライアントは進行中のクエリが無い（マイグレーション
  本体の適用中はずっとアイドルで接続だけ保持する）ため、「進行中のクエリの reject」
  という逃げ道すら無い。

## 決めたこと

1. **`pool.connect()` で借りたクライアントに、モジュールで1つだけの共有された
   no-op `error` リスナーを付ける**（`migrate.ts`/`advisory-lock.ts` それぞれに
   `NOOP_CLIENT_ERROR_HANDLER` という定数を置く）。実際のエラー処理は変えない——
   すでに存在する `try`/`catch`/`finally` が、`await client.query(...)` の reject と
   して同じ失敗を引き続き捕まえる。この listener が変えるのは「誰も聞いていない
   `error` イベントが Node の既定動作で uncaught exception になる」経路を
   「聞いてはいるが何もしない」経路に変えるところだけである。
2. **`catch` 節の `ROLLBACK` を `.catch(() => {})` で握り潰し、元の失敗（`err`）を
   常に基にして `throw` する。** 接続が既に失われている場合、`ROLLBACK` 自体が
   失敗し、それが `catch` 節の外へそのまま投げられると、呼び出し側に届く
   メッセージが「元々何が起きたか」ではなく「ROLLBACK が失敗した」に化ける
   ——ここでは意図的に二次失敗を捨て、一次失敗（本来 doc コメントが約束している
   `'migration <file> failed: ...'`）を優先する。ROLLBACK が本当に効く場面
   （接続が生きている、通常の DDL エラー）ではこれまでどおり実行される。
3. **同じ関数参照を `on`/`removeListener` の両方に使い、`client.release()` する
   すべての経路で対にして外す。** `pg-pool` は接続を pool へ返却してもソケットは
   切らずに次の `pool.connect()` で使い回す。呼び出しのたびに新しい `() => {}` を
   作って `on` するだけだと外せず、同じ物理コネクションにリスナーが積み上がって
   `MaxListenersExceededWarning`（既定上限10）に達する——実際に、この対策を
   入れる前の版でこれを引き当てた（`migrate.test.ts` ほか、複数マイグレーション
   ファイルを同一プールで適用する既存の歯を流したときに実測）。

## ⚠ [ADR 0020](./0020-temp-database-drain-before-drop.md) が却下した案とは別の話である

ADR 0020 は、CI の使い捨てテスト DB の後始末（`DROP DATABASE ... WITH (FORCE)`）が
**自分自身の `pool.end()` がソケットを閉じ切る前に resolve する**ことに起因して、
まだ生きている自分の接続を FORCE が殺し、それを `pool.on('error', ...)` の
リスナー欠如で uncaught exception にしていた事例を扱っている。ADR 0020 は
「`pool.on('error', () => {})` で症状だけ黙らせる」案を明示的に却下した——
**理由は、それでは「閉じ切れていない接続が残っている」という本当の不具合（自傷）を
検出できなくなるからである。**

本 ADR が直しているのは、構造が異なる。

| | ADR 0020 の事例 | 本 ADR の事例 |
|---|---|---|
| 誰が接続を壊すか | **自分自身**（`WITH (FORCE)` が、閉じ切れていない自分の接続を殺す） | **外部要因**（DB の再起動・フェイルオーバー・運用者の切断・OOM kill） |
| リークの有無 | 有り（`pool.end()` の resolve が早すぎる、が根本原因） | 無し（`client` は常に `finally`/`releaseAdvisoryLock` で正しく `release()` される） |
| `error` リスナーを付ける対象 | `Pool` 自体（`pool.on('error', ...)`） | **`pool.connect()` が返す個々の checked-out client**（`client.on('error', ...)`） |
| `pg` 自身の要求 | 無し（`Pool` の `error` は「pool 内部で idle client が壊れた」ことの通知であり、根本を直すべき信号） | **有り**——`pg` は「checked-out client の接続断は、借りた側が自分で `error` を拾うこと」と文書化しており、これを拾わないのは pg の使い方の不備そのものである |
| この ADR が保証しないこと | — | 「外部要因による接続断そのものを無くす」ことは保証しない。保証するのは「無くならなかったときに、プロセスを落とさず、約束どおりの `Error` で reject する」ことだけである |

⟹ **`pool.on('error', () => {})` を今回も却下する**（本 ADR も ADR 0020 と同じ判断を
踏襲する）——症状を消すのではなく、`client` 単位で意図した経路（`catch` の reject）
へ倒すのが目的であり、`Pool` 全体を黙らせる話ではない。

## 引き受けた負債

- **lock 保持用クライアントが死ぬと、マイグレーション本体は（別コネクションなので）
  最後まで正しく完了しうるにもかかわらず、`runMigrations` 全体は最後の
  `releaseMigrationLock`（`pg_advisory_unlock`）の失敗により reject する。**
  「本体は成功したが、呼び出し全体は失敗として報告される」という非対称が残る
  ——`migrate-connection-loss.test.ts` の2本目の歯が実際にこの形を記録している。
  advisory lock は PostgreSQL のセッションに紐づくため、明示的な `unlock` が
  失敗してもセッション終了（接続断）でサーバー側が自動的に手放す——次の
  `runMigrations` 呼び出しが解放されないロックを待ってハングすることは無い
  （同歯の追走で確認済み）。**呼び出し全体の成否を、マイグレーション本体の成否と
  ロック解放の成否とで分けて返す**ところまでは、この ADR の範囲では踏み込んでいない。
- 3つの既存テストの偽 `Pool`（`migrate-default-path-unchanged.test.ts` /
  `extension-mode.test.ts`）が、`client.on`/`client.removeListener` を持たない
  ことでこの変更により壊れたため、no-op の実装を足して直した——**この偽 `Pool`
  が今後さらに新しい checked-out client の面（例えば別のイベント）を要求される
  ようになったときに、また追随が要る**という構造は変わっていない。

## 確かめていないこと

- **本番相当の負荷・多重度の下で、この listener の追加そのものが性能に影響するか**
  は測っていない——`() => {}` を1つ `on`/`removeListener` するだけであり、実測の
  必要は薄いと判断したが、計測はしていない。
- **`pg` の将来のバージョンで `error` イベントの発火条件・タイミングが変わった場合**
  に、この対策が今と同じ形で有効かは検証していない（`pg@8.23.0` での実測）。
- **`registerEmbeddingSpace` 自身**（`vector-space.ts`）は `acquireAdvisoryLock` を
  経由するため、ロック保持用クライアントについては本 ADR の対象に自動的に含まれるが、
  `registerEmbeddingSpace` が発行する `CREATE TABLE`/`CREATE INDEX` は `pool.query(...)`
  （`pool.connect()` を経由しない、都度別のコネクションを使う経路）で発行しており、
  こちらは元々 `pg-pool` が単発クエリとして安全に扱う経路なので対象外——
  ただし、この判断は `pg-pool` の実装を読んで導いたものであり、同種の fault injection
  では実測していない。
