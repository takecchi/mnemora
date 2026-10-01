# ADR 0444: `db.transaction()` の `begin` が失敗した接続を pool へ戻す・`rollback` の失敗で元のエラーを消さない・`closePostgresClient` を `pool.end()` の直接呼びの後でも reject させない・文書の §11 との結び目を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー）の委譲先が書いた。直し方はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探し19巡目で、手元の PostgreSQL 17 に `pg_ctl restart -m fast` を繰り返しかけながら `observe` などを回した。次を確かめた。

  1. **【実測・BG-1】Postgres の再起動を数回挟むと、`@mnemora/postgres` の pool が枯れ、全呼び出しが止まる。**
     原因は drizzle-orm 0.45.2 の `NodePgSession.transaction`【現物】
     （`node_modules/.pnpm/drizzle-orm@0.45.2*/node_modules/drizzle-orm/node-postgres/session.js` の `async transaction(...)`）である。
     `await tx.execute(sql\`begin\`)`が`try { … } finally { session.client.release() }`の**外**に在る。`begin`が reject すると`finally`に届かず、借りた接続が pool に戻らない。接続を借りてから`begin`を撃つまでの間に切られると、これが起きる。`begin` の直前に接続を切る注入では、`observe`・`tick`・`forget`・`purge`・`consolidate`・`markContested`・`eraseTenant`・`purgeExpiredEvents`・`reextract` の
すべてで、借りたままの接続が1本残った（`pool.totalCount - pool.idleCount === 1`）。
  2. **【実測・BG-2】`rollback` が失敗すると、元のエラーが消える。**同じ関数の `catch { await tx.execute(rollback); throw error }` は、`rollback` が投げると
     `error` を捨てる。接続ごと切れたとき、`rollback` も「Client has encountered a connection error and is not queryable」で失敗するので、
     呼び出し側には `Failed query: rollback` しか残らなかった（実際の再起動で、実行中だったエラーの3/3がこの形）。`forget`・`purge` の `outcomes[].error` も同じだった。
  3. **【実測・BG-3】接続を借りる段階の失敗と、文の実行中の失敗とで、`code` の在り処が違う。**文書に書かれていなかった。
  4. **【実測・BH(c)】`closePostgresClient` は、同じ client への2回目以降の呼び出しには reject しない（Issue #935）が、利用者が `client.pool.end()` を直接
     呼んでいた場合は `Called end on pool more than once` で reject する。**覚えているのは `closePostgresClient` を通った呼び出しだけだった。
  5. **【現物・BI】`packages/core/src/__tests__/lifecycle-transition-table.ts` の `DOC_ROW_LINKS` は、`docs/memory-model.md` §11 の表の15行のうち
     8行（5・6・7・8・9・10・14・15）しか結んでいない。**

- **決めたこと**:

  1. **【BG-1】`createPostgresClient` が drizzle に渡す pool の `connect` の包み（`connectWithErrorListener`、Issue #868・ADR 0349 の続き）で、借りた接続の
     `query` を包み、`begin` が reject したら `release(err)` する。**接続は pool から捨てられ、`totalCount` から外れる。
     **`release` は冪等にする**——2回目以降は何もしない。仮の修正（`begin` の失敗で返す）では、drizzle のあとの `release` と二重になり、
     pg-pool の「Release called on client which has already been released to the pool」が出た。
     捨てる接続（`release(err)`）には、`error` のリスナーを外さずに残す（pool が捨てたあとに切断の `error` が届いても、プロセスを落とさない）。
  2. **【BG-1 に付随して見つかった、既存の窓】借りる包みは、pg-pool の callback 形（`pool.connect(cb)`）で借りる。**promise 形で借りると、借りた直後の
     microtask までのあいだ、接続に `error` のリスナーが1つも無い（pg-pool は借りる瞬間に自分のリスナーを外す）。接続を張った直後に切られると、
     「接続完了」と「切断の `error`」が同じ socket の読み出しの中で続けて処理され、リスナーを付ける前に後者が出て、プロセスごと落ちる。
     全接続を切る反復の歯を書いて見つかった。**直す前の実装でも、同じ反復で同じ落ち方をした**（【実測】）。callback は pg-pool が同期で呼ぶので、窓が無い。
  3. **【BG-2】`rollback` の失敗は握り、元のエラーを投げる。**`rollback` の `query` が reject したら、握って resolve し（drizzle が元のエラーを投げ直す）、
     失敗を `AsyncLocalStorage` の記録へ退避する。`db.transaction()` を包んだ関数が、投げられたエラーに失敗を足す: **元のエラーの `cause` が空いていれば `cause` に、
     空いていなければ `rollbackError` に**置く（drizzle が包んだ `DrizzleQueryError` は `cause` が埋まっているので、後者になる）。**新しい例外の型は作らない。**
     握った接続は `release(err)` で捨てる（壊れた接続を pool へ戻さない）。**ふつうの失敗（`rollback` が成功する）は何も足さず、同じ例外オブジェクトのまま投げる。**
     drizzle の内部（`session.client` など）には依らない。`AsyncLocalStorage` を使うのは、`connect()` が呼ばれた文脈から、その `db.transaction()` の記録を引くため。
  4. **【BG-3】`packages/postgres/README.md` の「例外の見分け方」に、形を3つ名指しで書いた。**①包まれていない `pg` の例外（`err.code`）、②`DrizzleQueryError`（`err.cause.code`）、
     ③`code` を持たない例外（pool の枯渇: `timeout exceeded when trying to connect`）。**形を揃える直しはしていない。**`rollback` の直しで形が変わった箇所
     （文の実行中の失敗がいまは元のエラーの形で届く）は、直したあとの実測で書いた。
  5. **【BH(c)】`closePostgresClient` は、`pool.ending` か `pool.ended` なら `pool.end()` を呼ばない。**`ended` なら即 resolve、`ending`（終わる途中）なら `ended` になるまで待つ。
  6. **【BI】`DOC_ROW_LINKS`（出発状態 × 操作のマスで結ぶ）に加えて、`DOC_ROW_OBSERVATIONS`（新しく作られる Memory・掃除を別の観測で結ぶ）を足し、行2・11・12・13を結んだ。**
     行1・3・4は結べない（理由は `lifecycle-transition-table.ts` のコメントに書いた。状態もイベントも動かないか、`observed` が `memories.status` の値ではない）。
     **今の振る舞いを縛るだけで、振る舞いは変えていない。**
  7. **上流の drizzle-orm には報告しない。**これは上流の不具合であり、ここで包んで直した（クローン miku の決定）。drizzle が直したら、この包みは要らなくなる。
     包みは、drizzle が `begin` を `finally` の中へ入れても、`rollback` の失敗で元のエラーを消さなくなっても、壊れずに通る形にしてある
     （`begin` の失敗の `release` は冪等、`rollback` の握りは何も無ければ働かない）。

- **検討した代替案**:

  1. **drizzle の `NodePgSession.transaction` を、自分で書き直した関数に差し替える。**採らなかった。drizzle の内部の形（`NodePgSession`・`NodePgTransaction`）に依ることになり、
     drizzle の版が上がるたびに壊れうる。`client.query` を包む形は、`pg` の公開の面だけに依る。
  2. **`db.transaction()` の中で、呼び出し側に `begin` の失敗を `release` させる。**採らなかった。store の全箇所に同じ処理を足すことになり、足し忘れが漏れになる。
  3. **`rollback` の失敗を、新しい例外の型（`TransactionRollbackFailedError` など）にして投げる。**採らなかった（クローン miku の決定: 新しい例外の型は作らない）。
     `code` 付きの元のエラーが呼び出し側に届くことが目的であり、型を足すと `instanceof` の枝が増える。
  4. **`rollback` の失敗を、元のエラーのメッセージへ連結する。**採らなかった。`code` や `cause` の形を壊さずに追記できる `cause`／`rollbackError` のほうが、機械で読める。
  5. **例外の形を揃える（接続を借りる段階の失敗も `DrizzleQueryError` で包む、など）。**採らなかった。公開の約束が動く（`err.code` を見ている呼び出し側が壊れる）。文書に書くまでにした。
  6. **`closePostgresClient` が、`pool.end` を差し替えて、直接の呼び出しも覚える。**採らなかった。公開の `pool` を書き換えない方針（ADR 0349）に反する。pool 自身の `ending`/`ended` を読む。
  7. **再起動の反復の歯を、CI で `pg_ctl restart` を使って書く。**できなかった。下の「CI で `pg_ctl` が使えない理由」を見ること。

- **CI で `pg_ctl` が使えない理由と、代わりの形**:

  CI の `postgres` ジョブ（ほか pgvector を使うジョブ）は、`services:` の `pgvector/pgvector:pg17` コンテナの Postgres を使う【現物】（`.github/workflows/ci.yml`）。
  テストを走らせる runner のプロセスには、そのコンテナの PGDATA も、`pg_ctl` で再起動する手段も無い（コンテナを `docker restart` するのは、job の `services` の外の操作になる）。
  **代わりに、`pg_terminate_backend` で、`application_name` が一致する全接続を負荷の最中に繰り返し切る歯**を置いた
  （`packages/postgres/src/__tests__/transaction-begin-release.postgres.test.ts` の「負荷の最中に全接続を切る反復をしても、pool は枯れない」）。
  切るのは接続だけで、サーバー自体は止まらない。**この歯は「再起動で pool が枯れる」現象の、接続が切れる側面だけを縛る**——サーバーが止まっている間の `ECONNREFUSED`・起動中の `57P03` は縛れない
  （`begin` の失敗の機序は同じなので、決定的に縛るのは `begin` の直前に切る歯のほう）。**実際の `pg_ctl restart -m fast` の反復は、手元で走らせて確かめた**（下の「測ったこと」）。CI には載せていない。

- **引き受けた負債**:

  - **drizzle の入れ子の `transaction`（`tx.transaction()`、savepoint）の `rollback to savepoint` の失敗は、まだ元のエラーを消す。**この包みは `begin` と素の `rollback` だけを見る。
    `@mnemora/postgres` の store は入れ子の `transaction` を使っていないことを確かめていない【未確認】。
  - **`rollbackError` と `cause` の2つの置き場がある。**元のエラーの `cause` が空いているかどうかで変わる。1つに揃えると `cause` が埋まっている drizzle のエラーを書き換えることになる。
  - **`commit` が失敗したあとの `rollback` が失敗したとき**、投げられるのは `commit` の失敗（drizzle が投げ直す `error`）で、`rollback` の失敗は `rollbackError` に残る。`commit` の失敗が
    「実際にはコミットされていたか」は、この直しの範囲外（`observe` の再送の安全性は ADR 0407 決定4 のまま）。
  - **例外の形は揃っていない**（BG-3。文書に書いただけ）。
  - **`pg_ctl restart` の反復は CI に載せていない。**手元の実測に頼る。
  - `Client.prototype.query` を差し替える歯（`pool-fault-injection.ts`）は、`pg` の内部の呼び方（promise 形の `query`）に依る。`pg` の版を上げたら、歯が空振りしないかを見ること
    （注入が当たらなければ、`begin` の直前に切る歯は「reject しない」ので `rejects.toThrow()` で赤になる——静かに通ることは無い）。
  - 包みは、接続を借りるたびに `query` を差し替えて `release` で外す。借りた接続に別のコードが `query` を差し替えていたら、その上に重なる。

- **これが覆るとしたら**:

  - drizzle-orm が `begin` を `finally` の中へ入れ、`rollback` の失敗で元のエラーを消さなくなったとき。包みは要らなくなる（残しても害は無い）。
  - 例外の形を揃えたいとき（公開の約束を動かすことになるので、オーナーの判断）。
  - 入れ子の `transaction` を store が使うようになったとき。`rollback to savepoint` も同じ形で包む。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に走らせて赤を見てから直した）:

  - **直す前の実装（`origin/main` の `client.ts`）で、新しい歯は赤**:
    `transaction-begin-release.postgres.test.ts` の3本が赤（`begin` の直前に切ると `1回目の後: expected 1 to be +0`、`release` の冪等が
    `Release called on client which has already been released to the pool.`、全接続を切る反復で worker が終わらない）。
    `transaction-rollback-error.postgres.test.ts` の4本が赤（投げられるのが `Failed query: rollback`、`forget`・`purge` の `error` が `Failed query: rollback\nparams: (omit…`）。
    `client-close-idempotent.postgres.test.ts` の2本が赤（`Called end on pool more than once`）。直したあとは全部緑。
  - **実際の `pg_ctl restart -m fast` の反復**（12回、3接続の pool、3本の worker が `observe` を回し続ける。`.mgr-notes/bg-leak.mts`）:
    直す前は9回目まで通り、**10回目の再起動の後に worker が終わらず、pool が `total=3 idle=0 waiting=4`** になった（枯れた）。
    直したあとは12回とも `total=3 idle=3 waiting=0`、probe も通った。
  - **二重 `release` する実装（やりすぎ）で赤**: `begin` の失敗の経路で、冪等な `client.release` のあとに、pg-pool の素の `release` をもう一度呼ぶ変異を入れると、
    `begin の失敗で投げられるのは、begin 自身の失敗` が赤（`Failed query: begin <- Release called on client which has already been released to the pool.`）。
    冪等の守り（`if (released) return`）を消す変異では、`release は冪等` が赤。
  - **BH(c)**: `pool.end()` の直接呼びのあと、また `end()` の途中で `closePostgresClient` を呼ぶ、の2本。直す前は `Called end on pool more than once` で reject した。
  - **BI**: `docs/memory-model.md` §11 の行12のイベント欄を `created` から `updated` に変えると、`§11 行12のイベント updated: expected [ 'created' ] to include 'updated'` で赤になる。戻すと緑。
  - **BG-3 の実測**（`pg_ctl stop`/`start`・`pg_terminate_backend`・`max: 1` の pool を借り切って）: README の表のとおり。起動の最中の `57P03` は、起動の直後に撃ち続けて確かめた。
  - **測っていないこと**（未測定）: 入れ子の `transaction` の `rollback to savepoint` の失敗。Postgres 17 以外・`pg` の別の版での注入の当たり方。
    `commit` が失敗したときの「実際にはコミットされていたか」。
