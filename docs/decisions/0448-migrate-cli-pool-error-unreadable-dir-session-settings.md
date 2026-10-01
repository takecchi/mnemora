# ADR 0448: migrate の CLI の Pool に `error` のリスナーを付ける・`migrationsDir` が読めない／空のときの扱い・セッション設定（`statement_timeout` など）が本体に効くことを文書に書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直し方の線（何を直し、何を材料に回すか）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17 + pgvector、`initdb` で立てた自分専用のインスタンス）で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探し22巡目は、`runMigrations` と `mnemora-postgres-migrate` の外縁を見た。主な口は先の ADR が塞いでいる（[ADR 0425](./0425-migrate-warns-on-ledger-drift.md)＝台帳と手元のファイルの番号・名前のずれ、[ADR 0442](./0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)＝`0027` の deadlock と DDL のロック待ち、Issue #1212＝ロックを持つ接続の切断、#756＝部分適用、#757/ADR 0331＝拡張の共有ロック）。この ADR はそれらの範囲に入らない4点を扱う。

  1. **B4: CLI の `Pool` に `error` のリスナーが無い。** 【現物】`packages/postgres/src/bin/migrate.ts` は `new Pool({ connectionString })` を素で作る（`createPostgresClient` は使わない）。
     【実測】CLI と同じ形の `Pool` で、待機中の接続を1本置いて `pg_terminate_backend` で切ると、`Unhandled 'error' event`（`Client.idleListener` が `Pool` の `error` を emit）で exit 1 になった（既存の `pool-idle-loss-child.ts` の `raw` と同じ陽性対照）。
     ただし CLI の Pool が待機中の接続を持つのは、`runMigrations` がロックの接続を返してから `runAnalyzeMemories`・`pool.end()` までの短い間だけである（ロックを待つ間・本体を流す間の接続は、借りている最中で、`advisory-lock.ts` が自前のリスナーを付けている）。
     **CLI を丸ごと走らせて、この窓に当てることはできていない**（窓がマイクロ秒の幅で、外から刺す口が無い）。当てたのは「CLI と同じ Pool 生成」を子プロセスで走らせた形で、実際に落ちる確率は低い。
  2. **B2: `migrationsDir` が空・存在しない。** 【実測】まっさらな DB に、(i) 存在しないパス: ロック・（`schema` 指定なら `CREATE SCHEMA`・`CREATE EXTENSION`）・台帳の作成が済んだ**後**に、生の `ENOENT: no such file or directory, scandir …` で落ちる（台帳の表が残る）。
     (ii) `.sql` が1本も無いディレクトリ＋`schema` 指定: スキーマと拡張が作られ、`applied: []` で**何も言わずに成功**する。(iii) 同＋`schema` 未指定: 台帳の表を作ったあと、`type "vector" does not exist`（pgvector の能力検査）で落ちる——原因（`.sql` が無い）は出ない。
     CLI は同梱の既定のディレクトリしか使えないので、(i)(ii) に届くのはライブラリとして呼ぶ場合と、パッケージの展開で `migrations/` が欠けた場合だけである。
  3. **B3: セッション設定が本体の DDL に効く。** 【実測】`CREATE TABLE` のあとに `pg_sleep(2)` を置いた migration 1本で、`statement_timeout=500ms` を `ALTER ROLE`・`ALTER DATABASE`・`PGOPTIONS`・接続文字列の `options` のどれで渡しても、約0.5秒で `migration 9001_slow.sql failed: canceling statement due to statement timeout`。
     そのファイルは巻き戻り、台帳に行は載らず、`idle in transaction` の接続も advisory lock も残らなかった（`pg_stat_activity`・`pg_locks` で確認）。打ち直しても毎回同じところで落ちる。`PGOPTIONS="-c statement_timeout=0"`・`?options=-c%20statement_timeout%3D0` はロールの設定より優先され、通った。
     `ALTER ROLE … SET lock_timeout='100ms'` では、`RESET lock_timeout` がその値へ戻るので、別セッションが表を握っている間は本体も約0.1秒で `lock timeout` になった（README の既存の節が `lock_timeout` について書いている通り）。
     `ALTER ROLE … SET default_transaction_read_only=on` では、台帳の作成（`BEGIN` の外）が `cannot execute CREATE TABLE in a read-only transaction` で落ちた（`migration <file> failed:` では始まらない）。
     `idle_in_transaction_session_timeout=300ms` は影響しなかった（本体は1つの `query` で、トランザクションの中に待ちが無い）。
  4. **B1/ADR 0143: チェックサムは無い。** 【現物】台帳は `name` と `applied_at` だけで、適用済みはファイル名だけで判定する。[ADR 0143](./0143-analyze-memories-after-seed.md) の末尾付近は「`migrate.ts` の適用済みマイグレーションのチェックサム検査、ADR 0032 参照」を、`0003`・`0008` のコメントを直さない理由に挙げていたが、**その検査は migrate.ts にも ADR 0032 にも無く、`git log -S` でも一度も入ったことが無い。**

- **決めたこと**:

  1. **B4: CLI の `Pool` に `error` のリスナーを付ける。** `createMigrateCliPool`（`packages/postgres/src/bin/cli-pool.ts`。公開しない）が `new Pool` と `pool.on("error", …)` をまとめ、`bin/migrate.ts` はそれを使う。
     リスナーは `createPostgresClient` と同じ文頭 `POOL_ERROR_WARNING_HEAD` で `console.warn` して続行する（切れた接続は pool が捨て、次の問い合わせは新しい接続で通る）。
     歯は `migrate-cli-pool-idle-loss.test.ts`（子プロセス。`pg_terminate_backend`。直列群）。**直す前の形（リスナー無し）で、3本のうち「落ちず、名乗り、次の問い合わせが通る」の1本が赤になり**（exit 1・`Unhandled 'error' event`）、陽性対照（素の `pg.Pool`）と「`bin/migrate.ts` が `new Pool(` を持たない」の2本は緑のまま、直すと3本とも緑になった。
  2. **B2（読めない）: DB に触れる前に、引数を名指しして落とす。** `runMigrations` は `migrationsDir` の列挙を入口（`assertSafeSchemaName` の直後・ロックと拡張の確認の前）で行い、読めなければ `runMigrations: migrationsDir を読めない（<パス>）: <元の message>` の `Error`（`cause` に元の例外、`code` は元の文字列のまま）で落ちる。
     **落ちる入力は増えない**（以前も同じ入力で落ちていた）。**新しい例外のクラスは作らない**（公開 API を増やさない）。`listMigrationFiles`（公開）の挙動は変えていない。副作用（`CREATE SCHEMA`・`CREATE EXTENSION`・台帳の作成）が、失敗の前に出なくなる。
  3. **B2（空）: 警告を出す。** `describeLedgerDrift`（ADR 0425）に (c)「`.sql` が1本も無い」を足し、`console.warn` で名乗って続行する（`applied: []` の成功は変えない）。**CLI の終了コードは変えない**（CLI は既定のディレクトリしか使えない）。
  4. **B3: 文書だけを直す。** `packages/postgres/README.md` に、「接続・ロール・DB の `statement_timeout` などは本体にも効く」の節を足し、実測（巻き戻る・台帳に載らない・状態が残らない）と、migrate を流す接続だけ無効にする書き方（接続文字列の `options`・`PGOPTIONS`）を書いた。既存の `lock_timeout` の節の「測っていないもの」を、測った範囲に合わせて狭めた。
  5. **ADR 0143 の訂正は追記で行う。** 本文は書き換えず、末尾に「チェックサム検査は migrate.ts にも ADR 0032 にも無い」を追記した。`0003`・`0008` のコメントは直していない（コメントを直すかは、出荷済みファイルを書き換えない規約 ADR 0001・0057 の側で決める）。
  6. **B1（内容ハッシュ）と runner による `statement_timeout` の上書きは、材料に回す**（下の「材料」）。

- **検討した代替案**:

  1. **B2 を、空のディレクトリで throw にする。** 採らなかった。以前は成功していた呼び出し（たとえば空のディレクトリを渡す設定の試験）が、新しく落ちる。「断る・落とす入力を今より増やさない」に反する。警告に留めた。
  2. **B2 の ENOENT を、専用の例外クラス（`MigrationsDirUnreadableError` など）で投げる。** 採らなかった。公開 API が増える（`index.ts` は `export * from "./migrate.js"`）。既存の `Error` に `cause` を付け、`code` を元のまま持たせた。
  3. **B4 で `createPostgresClient` を CLI に使う。** 採らなかった。drizzle・`search_path` の起動パラメータまで持ち込み、CLI の接続の形（`runMigrations` の `SET LOCAL search_path` が責務）が変わる。リスナー1つで足りる。
  4. **B4 の `pool.on("error")` を黙って捨てる（空のリスナー）。** 採らなかった。[ADR 0020](./0020-temp-database-drain-before-drop.md)・[ADR 0356](./0356-pool-default-error-listener-warns-by-default.md) と同じく、名乗る形にした。
  5. **B3 を runner の `SET LOCAL statement_timeout = 0`（本体のトランザクションの中だけ）で直す。** 採らなかった。利用者が `statement_timeout` を掛けているのは意図（暴走したクエリの上限）であることが多く、migrate だけ無効にするのは**既定の振る舞いの変更**である。大きい表の索引の構築が、これまで上限で止まっていた環境で、上限なしに走り出す。材料に回した。

- **材料（オーナーの判断を待つ。この PR では変えていない）**:

  - **B1: 内容ハッシュの列。** 台帳に `checksum` 列を足し、適用時に本文のハッシュを記録して、適用済みのファイルの本文が変わっていたら警告する案。直さなかった理由: (a) 台帳の列追加は migration（既存の行は NULL）で、**遡って埋められない**——出荷済みの32本のハッシュは「いまの手元のファイル」から作るしかなく、v1.0.x で当てた DB の実際の本文とは一致の保証が無い。
    (b) **偽陽性率に上限を置けない**（改行コード・git の `autocrlf`・末尾の改行・BOM で本文のバイト列が変わる。AGENTS.md「偽陽性率に上限を置けない検査は門にしない」）。警告に留める形なら門ではないが、毎回の警告は無視されて形骸化する。
    (c) `describeLedgerDrift` に足す形で公開面は増えないが、台帳の schema が変わるので `docs/migration-v1.md` の「破壊的」の判断が要る。
  - **B3: runner が `statement_timeout` を上書きするか。** 上の代替案5。上書きするなら、`SET LOCAL statement_timeout = 0` を本体のトランザクションの先頭に足すだけで、元の値は `BEGIN` の外には漏れない。「既定を変える」判断なので、オーナーが決める。
  - **B2 の続き: `.sql` が無いときに止める**（`strict` のような opt-in の公開オプション、または新しい例外の型）。公開 API が増える。
  - ADR 0425 が「止めない」を選んだ線（警告のみ）は、この ADR も踏襲している。

- **測っていないこと**:

  - CLI を丸ごと走らせて、`runMigrations` が接続を返してから `runAnalyzeMemories` までの窓に切断を当てること（できていない。B4 の歯は「CLI と同じ Pool 生成」を子プロセスで走らせた形）。
  - `PGOPTIONS`・`ALTER DATABASE` で渡した `lock_timeout`。pgbouncer などの接続プール越し。`statement_timeout` 以外のセッション設定（`default_transaction_read_only` の `ALTER ROLE` 以外の渡し方、`search_path` をロールに掛けた場合）。
  - 実際に重い migration（大きい表への `CREATE INDEX`）が `statement_timeout` で落ちる時間。測ったのは `pg_sleep` を含む1本だけ。
  - `.sort()`（UTF-16 順）と 4桁0詰めの前提が崩れる自前の `migrationsDir`（B5）、旧台帳の列が違う場合の改名（B6）。下調べで挙げたが当てていない。
  - 再現しなかったものは無い。当てた形の一覧は `.hunt-r22/`（commit しない）に残した。

- **引き受けた負債**:

  - B4 の歯は、CLI そのものではなく生成関数を縛る。`bin/migrate.ts` が `createMigrateCliPool(` を使うことは、ソース文字列の検査で縛っているだけである（別の書き方で `Pool` を作り直す変更は、この検査では防げるが、意図まで縛れない）。
  - B2 で、`migrationsDir` の列挙が「ロックの下」から「ロックの前」に移った。列挙とロック取得の間に、別のプロセスがファイルを足す・消す余地が、理屈の上では広がる（ファイルは出荷物で、実行中に変わらない前提）。測っていない。
  - 失敗の文言が変わる（先頭が `ENOENT: …` から `runMigrations: migrationsDir を読めない（…）` へ）。`err.message` を正規表現で拾う呼び手は影響を受ける。`code` は元のまま持つ。
  - B3 は文書だけである。`statement_timeout` を掛けた環境では、migrate は今までどおり落ちる。

- **これが覆るとしたら**:

  - 空の `migrationsDir` を渡して成功を期待する呼び手が居ない（警告が不要）と分かれば、(c) を落として、止める（opt-in）案に進める。
  - B3 で、`statement_timeout` に阻まれた migrate の報告が実際に出れば、runner が本体だけ無効にする案（代替案5）を、オーナーの判断で採れる。その場合は `docs/migration-v1.md` の「挙動が変わる」に入れる。
  - 台帳の内容のずれによる実害（書き換えた migration が再適用されず、DB ごとに schema が違った）が報告されれば、B1 を opt-in の警告として検討する。
