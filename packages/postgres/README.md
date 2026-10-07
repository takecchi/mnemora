# @mnemora/postgres

`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore` の
Postgres + pgvector 実装（[docs/memory-model.md](../../docs/memory-model.md) §10）。
マイグレーション実行用の CLI（`mnemora-postgres-migrate`）も含む。

## インストール

```bash
pnpm add @mnemora/postgres @mnemora/core
# または
npm i @mnemora/postgres @mnemora/core
```

下の「動く最小の例」をそのまま動かすなら、`@mnemora/openai` も入れる（例の LLM・埋め込みは OpenAI を使う）。README の install 行だけを pnpm で入れると、例は `Cannot find package '@mnemora/openai'` で止まる（2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れて確かめた）。

⚠ **TypeScript で `skipLibCheck: false` にしていると、`drizzle-orm`（このパッケージの依存）の型定義そのものがエラーを出す**（`Cannot find module 'gel'`・`'mysql2/promise'` など。`drizzle-orm` の `column-builder.d.ts` が使わない方言の型まで読み込むため）。`@mnemora/postgres` 自身の型は `moduleResolution` が `node16`・`bundler` のどちらでもエラー無く解決する。`skipLibCheck: true`（`tsc --init` の既定）にすること。

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `module`/`moduleResolution` を `nodenext` にし、TypeScript 5.8 以降を使うこと。
  5.7 以前の `nodenext` と、どの版の `node16` も `TS1479` になる。`node10` は TypeScript 5.x なら
  パッケージの入口の型を解決できるが、`exports` を読まないので `@mnemora/testkit/fixtures` のような
  subpath は解決できず、TypeScript 6 で非推奨・7 で廃止された。2026-09-27 に TypeScript 5.0〜7.0 で実測）
- **TypeScript の `lib`・`target` は ES2022 以上**。公開の `.d.ts` が `ErrorOptions`（ES2022 の lib）を使う（`trigram-lexical-store` の `TrigramLexicalStoreUnavailableError` のコンストラクタ。`@mnemora/core` の `memory-store`・`vector-store` の例外クラスも同じ）。
  ES2021 以下で `skipLibCheck: false` だと `TS2304`、`skipLibCheck: true` だと `cause` の型が失われる
- **CommonJS へ変換するテストランナー（ts-jest 等）からも読める。**配布物に
  `import.meta` を含めていないため（[ADR 0086](../../docs/decisions/0086-no-import-meta-in-published-artifacts.md)）。
  `import.meta` は CommonJS として解析されると**構文解析の時点で**落ちるので、
  1箇所在るだけで「import しただけで落ちる」状態になる
- **`tsc` を `skipLibCheck: false`（unset のままでも同じ——TypeScript 自体のコンパイラ
  既定値が `false`）で走らせる consumer が `@mnemora/postgres` を import すると、
  自分のコードとは無関係な型エラーが出ることがある。**【実測、drizzle-orm 0.45.2 /
  TypeScript 5.9.3、2026-09-26】公開 `@mnemora/postgres@1.0.1` と main を
  `pnpm pack` したもの、どちらを `moduleResolution: NodeNext` の素の consumer から
  import しても70件——全件 `node_modules/drizzle-orm/**/*.d.ts` 由来（`gel` /
  `mysql2/promise` 等、未インストールの任意 peer 向け型の欠落や drizzle-orm 内部の
  構造的な型の不整合）で、`@mnemora/*` 自身の `.d.ts` からは0件。`drizzle-orm` を
  mnemora を介さず単独 import するだけでも同条件で再現する（84件）ため、
  **mnemora 固有の型の欠陥ではない**（[Issue #893](https://github.com/takecchi/mnemora/issues/893)）。
  `tsc --init` が書き出す既定テンプレートは `skipLibCheck: true` なので、多くの consumer は
  踏まない。回避策は `skipLibCheck: true` を明示すること。
- **本物の Postgres + pgvector が要る。**擬似物・インメモリでの代替は無い
  （このリポジトリの CI は [`pgvector/pgvector:pg17`](https://hub.docker.com/r/pgvector/pgvector) の
  Docker イメージに対して実行している。実物は
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) を参照）。
- 接続先には次の3拡張が要る: **`vector`**（pgvector）・**`btree_gin`**・**`pgcrypto`**。
  `mnemora-postgres-migrate`（後述）の `migrations/0001_init.sql` が
  `CREATE EXTENSION IF NOT EXISTS` で作成を試みるが、接続ロールに拡張を作る権限が無い
  環境ではあらかじめ DBA 側で作っておくこと。そのうえで `--extension-mode verify`（後述）を
  付けて流すと、`CREATE EXTENSION` を1文も発行せず、3拡張が在ることだけを確かめる
  （[ADR 0093](../../docs/decisions/0093-extension-verify-mode.md)）。
  **この3つで足りる——`pg_trgm` 等の追加の拡張は要求しない**
  （[ADR 0084](../../docs/decisions/0084-lexical-recall-channel.md) §3・
  [ADR 0149](../../docs/decisions/0149-japanese-lexical-no-required-extension.md)）。
  **⚠ ただしその代償として、`recall()` の語彙(lexical)チャンネルは日本語の文に埋もれた
  日本語の語（人名を含む）を引けない。**日本語表記のチャンネル名・社内システム名に
  ついても、人名と同じ穴に落ちる可能性が高いが確かめていない
  （[ADR 0149](../../docs/decisions/0149-japanese-lexical-no-required-extension.md)）。
  - **opt-in で `pg_trgm` を使う代替実装がある**（`PostgresTrigramLexicalStore`、
    [ADR 0319](../../docs/decisions/0319-optional-trigram-lexical-store.md)、
    Issue #278）。`REQUIRED_EXTENSIONS` には含まれない——`PostgresTrigramLexicalStore.create(db)`
    を呼んだときだけ `pg_trgm` の `CREATE EXTENSION` を試みる。**前提が2つ要る**:
    `server_encoding` が `UTF8` であること、かつ現在のロケールで日本語のトライグラムが
    実際に作れること（`C` ロケールのクラスタでは `pg_trgm` 自体は入っても日本語の
    トライグラムが黙って空になる——ADR 0084 §3.2）。前提を満たさなければ
    `create()` が例外を投げる（黙って `PostgresLexicalStore` 相当に縮退しない）。
    照合の精度・閾値の根拠、`retrieval` ベンチでの実測（悪化していないが、対象の
    probe 集合は語彙的な重なりをほぼ持たない設計であることも含む）は ADR 0319 を見ること。
    ⚠ **専用スキーマ（`schema` を渡す構成）では、`pg_trgm` は `extensionSchema` ではなく、最初に
    `create()` した名前空間のスキーマに入る。**同じ DB の2つ目の名前空間では `create()` が名前の付かない
    DB の例外（`function word_similarity(…) does not exist`）で落ちる。複数の名前空間で使うなら、先に
    共通のスキーマへ `CREATE EXTENSION pg_trgm WITH SCHEMA public` などで入れておくこと
    （今の振る舞い。[Issue #1256](https://github.com/takecchi/mnemora/issues/1256)）。
- **pgvector は `>= 0.8.0` が必須。** `hnsw.iterative_scan`（`relaxed_order`、ANN 段の
  フィルタ問題対処、[ADR 0284](../../docs/decisions/0284-hnsw-iterative-scan-relaxed-order-adopted.md)）を
  使うため。`>= 0.8.2`（CVE-2026-3172 のバッファオーバーフロー修正を含む）を推奨する。
  **満たしていないと `PgvectorVersionUnsupportedError` が投げられる**——検査は2箇所:
  `PostgresVectorStore.search()`/`searchMany()`（インスタンスごとに初回呼び出しでだけ）と
  `mnemora-postgres-migrate`（`--extension-mode create`/`verify` 両方）。判定は
  `pg_extension.extversion` の文字列比較ではなく、`pg_settings` の
  `hnsw.iterative_scan` 行が実際に `relaxed_order` を解釈できるかという**能力**で行う
  （[ADR 0367](../../docs/decisions/0367-pgvector-capability-check.md)）——ライブラリが
  実際に 0.8.0 以上なら `extversion` が古いままでも通る。エラーメッセージには
  `installed`（読めた版。無ければ `undefined`）・`required`（`"0.8.0"`）・
  `missingCapability`（`"hnsw.iterative_scan"`）が載る。**検査を外すオプションは無い。**
  直し方はライブラリを 0.8.0 以上へ上げるか、`ALTER EXTENSION vector UPDATE;` を実行すること。
- 接続文字列は環境変数 `DATABASE_URL` で渡す。

## マイグレーション（`mnemora-postgres-migrate`）

このパッケージは bin `mnemora-postgres-migrate` を提供する
（実体は [`src/bin/migrate.ts`](./src/bin/migrate.ts)、引数解釈は
[`src/bin/cli-options.ts`](./src/bin/cli-options.ts)）。`DATABASE_URL` を読み、
保留中の `migrations/*.sql` をファイル名の昇順で適用する。

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate
```

- 適用対象が無ければ「適用対象のマイグレーションはありません（すべて適用済み）。」と出て終わる。
- 適用したファイル名を一覧で出す。
- 複数プロセスが同時に実行しても安全（advisory lock で直列化する）。
- 途中でプロセスが落ちても（kill されても）、当てている途中のファイルは巻き戻り、台帳には載らない
  （ファイルごとに1トランザクション）。ロックはそのプロセスの接続が切れた時点で手放されるので、待っていた
  別のプロセスがそのまま続きから当てる。打ち直しても、適用済みのファイルは二重に当たらない。
- ロックを持つ接続が DB 側の切断・フェイルオーバーなどで切れると、当てている途中のファイルもそこで止まって巻き戻り、
  台帳には載らない（ロックの下で流すものは、すべてロックを持つ接続そのもので流す）。失敗は
  `migration <file> failed: ...` として報告される。ロックが外れた後に本体が流れ続けて、別の実行と重なることは無い
  （[Issue #1212](https://github.com/takecchi/mnemora/issues/1212)。1.0.2 までは本体を別の接続で流していたので、
  ロックの接続だけが切れると適用がロックの無いまま続き、別の実行と重なりえた）。打ち直せば、そのファイルから続きを当てる。
  `src/__tests__/migrate-connection-loss.test.ts` が縛っている。
- 既定（`--extension-mode create`）で、拡張を作る権限の無いロールで流すと、`migration 0001_init.sql failed: permission denied to
create extension "vector"` で始まる文言で終わる。その次の行に、どうすればよいか（上の「接続先には次の3拡張が要る」の項目のとおり、
  DBA 側で作ってから `--extension-mode verify` で流す）の案内が続く（[Issue #1212](https://github.com/takecchi/mnemora/issues/1212)。
  1.0.2 までは案内が無かった）。案内が付くのは、`CREATE EXTENSION` が権限不足で失敗したとき（pg のエラーの `code` が `42501`、
  `routine` が `execute_extension_script`）だけで、文言の先頭と例外の種類は変わらない。`src/__tests__/migration-failure-message.test.ts` と
  `src/__tests__/extension-mode.postgres.test.ts` の測定4が縛っている。
- `--extension-mode verify` の確認は、ロックを取る前（ほかのプロセスの移行を待つ前）に、起動した時点の
  `pg_extension` を読む。同時に既定の `create` のプロセスが拡張を作っている最中だと、`verify` のほうは
  「必要な拡張が見当たりません」で失敗しうる——拡張ができた後に打ち直せば通る。
- **台帳と手元のファイルがずれていると、警告を出して続行する**（穴探し6巡目 S-1・S-3、ADR 0425）。止めない。適用の順序も中身も
  変えない。標準エラー（ライブラリとして呼んだときは `console.warn`）に `[@mnemora/postgres] migrate: ` で始まる文が出る。
  - **番号の小さい未適用のファイルがある**（台帳の最大の番号より小さい番号のファイルが、台帳に載っていない）。そのファイルも
    いまどおり当たるが、**当たり直しが、後に適用済みの migration が変えた内容を巻き戻しうる**。例: 台帳から
    `0011_memory_events_kind_restored.sql` の行だけが欠けた DB では、0011 が単独で当たり直り、0018 が足した `'unsuperseded'` が
    `memory_events_kind_check` から消える。出たら、台帳の行を誤って消していないか（手での編集・部分的な復元）、別の版の
    `migrations/` から流していないかを確かめる。巻き戻ったかどうかは `pg_get_constraintdef` などで DB 側を見ること。
  - **台帳に、手元の `migrations/` に無い名前がある**。**手元の版が DB より古い可能性がある**（新しい版で上げた DB に、古い版から流している。
    警告が無かった頃は「すべて適用済み」とだけ出た）。出たら、この DB を使っているアプリ・CLI の版を揃える。ファイル名を自分で変えたのなら、
    この警告は想定内である。
  - **`migrationsDir`（ライブラリとして呼ぶときの第2引数。CLI は同梱の既定のみ）に `.sql` が1本も無い**（[ADR 0448](../../docs/decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md)）。
    `migrate: migrationsDir に .sql が1本も無い。何も適用しない。` と出て、`applied: []` で成功する（以前も成功していた。止めない）。
    指定違い・パッケージの `migrations/` の欠けを疑うこと。専用スキーマを指定していると、スキーマと拡張はこの時点で作られる。
    ⚠ 専用スキーマを指定しない新規インストールでは、この後の pgvector の確認が `type "vector" does not exist` で落ちる（`0001_init.sql` が当たっていないので拡張が無い）。
    その場合も警告が先に出ている。
  - **`migrationsDir` が読めない**（存在しない・ディレクトリでない）。`migrationsDir を読めない（<パス>）: ENOENT: …` の `Error` で、**DB に触れる前に**落ちる
    （`cause` に元の例外、`code` は元のまま）。以前は、ロックの取得・`CREATE SCHEMA`・`CREATE EXTENSION`・台帳の作成が済んだ後に、生の `ENOENT` で落ちていた。
    `src/__tests__/migrate-dir-unreadable-empty.postgres.test.ts` が縛っている。
  - 警告を出さないための公開オプションは無い。止めたい運用は、標準エラーの出力を見て判断すること。
- **台帳は、適用済みの migration の内容を覚えていない**（列は `name` と `applied_at` だけ）。出荷済みのファイルの中身を書き換えても、適用済みの DB では再実行されず、
  警告も出ない（ファイルを置き換えた側の DB と、新規に作った DB で、中身がずれる）。内容の食い違いを見つける仕組みは無い（[ADR 0448](../../docs/decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md) の材料）。

### ⚠ `lockTimeoutMs` は DDL の表ロック待ちには効かない（上限を付けるなら接続側で）

- **`runMigrations` の `lockTimeoutMs`（既定 30 秒）が効くのは、advisory lock を待つ間だけである。**ロックを取った直後に
  `RESET lock_timeout` するので（`src/migrate.ts` の `runMigrations`。共有の拡張ロックを待つ `acquireExtensionLock` も、待つ間だけ敷いて
  `RESET` する）、本体の DDL が**表のロック**（稼働中のアプリが握っている表への `ALTER TABLE` など）を待つ間は、
  セッションの `lock_timeout` の既定値に従う。サーバの既定は `0`（上限なし）なので、**何も渡さなければ DDL はロックを待ち続ける**。
  `lockTimeoutMs` に小さい値を渡しても変わらない。
- **上限を付けたければ、接続側で `lock_timeout` を渡す。**次のどれでもよい。
  - 接続文字列: `DATABASE_URL=postgresql://user:pass@host:5432/mydb?options=-c%20lock_timeout%3D5s`（CLI もこれで効く）
  - pg の `PoolConfig`: `new Pool({ connectionString, options: "-c lock_timeout=5s" })`
  - ロール・DB の設定: `ALTER ROLE migrator SET lock_timeout = '5s'`（`ALTER DATABASE … SET` も同様）
- ⚠ `RESET lock_timeout` が戻すのは「セッションの既定値」であり、`0` ではない。接続の起動パラメータやロール・DB の設定で渡した値は、
  `RESET` のあとも残る。【実測】2026-09-30、PostgreSQL 17.11・ローカル。別セッションが `ACCESS EXCLUSIVE` で握っている表に
  `ALTER TABLE … ADD COLUMN` するマイグレーション1本を `runMigrations(pool, dir, { lockTimeoutMs: 100 })` で流した:
  接続文字列の `options`・`PoolConfig.options`・`ALTER ROLE … SET lock_timeout='2s'` の3通りは、いずれも約2秒で失敗した。
  何も渡さない場合は、握っている側が手放す（約8秒後）まで待って成功した（`lockTimeoutMs: 100` は効かなかった）。
  **測っていないもの**: `lock_timeout` を `ALTER DATABASE … SET`・`PGOPTIONS` で渡した場合（`statement_timeout` はこの3通りとも測った。下の節）、pgbouncer などの接続プール越し（起動パラメータが落ちる構成がありうる）。
- **時間切れになったとき**: そのファイルのトランザクションは `ROLLBACK` され、`migration <file> failed: canceling statement due to lock timeout`
  で throw される（`MigrationLockTimeoutError` ではない——あれは advisory lock の待ちの時間切れ）。台帳（`_mnemora_migrations`）にも
  載らないので、そのまま再実行できる（上の実測で、失敗後の台帳は空・列は増えていなかった）。
- ⚠ **DDL がロックを待っている間は、その後ろに並んだアプリの操作も止まる**（[ADR 0442](../../docs/decisions/0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)）。
  PostgreSQL は、待っている DDL より後から来たロックの要求を、その DDL の後ろに並べる。【実測】2026-10-01、PostgreSQL 17・ローカル。
  8秒続くアプリのトランザクションが `memories` に書いている裏で、`CREATE INDEX`（`ShareLock`）を当てると、後から来た `observe()` の書き込みが
  約8秒止まった（索引の構築そのものは約0.15秒。読み取りは止まらなかった）。`ALTER TABLE … ADD COLUMN`（`ACCESS EXCLUSIVE`）では、`recall()` も約8秒止まった。
  接続側で `lock_timeout=3s` を渡すと、migrate が3秒で `lock timeout` の失敗になり、アプリが止まるのも3秒までで済んだ（アプリ側のエラーは0件）。
  ⟹ 上の `lock_timeout` は、migrate の待ちだけでなく、**アプリが止まる時間の上限**にもなる。

- **`registerEmbeddingSpace` も同じ線である**（[ADR 0460](../../docs/decisions/0460-multi-process-multi-pool-round33.md)）。`lockTimeoutMs` が効くのは advisory lock の待ちだけで、DDL（`CREATE TABLE` / `CREATE INDEX`）の表ロック待ちには効かない。
  advisory lock を握った接続の中で DDL を打つので、`max: 1` の Pool でも止まらない（以前は DDL に別の接続が要り、`max: 1` では返らなかった）。呼び終えたあとの接続の `lock_timeout` は、接続側で渡した値のまま（以前は `0` に書き換えていた。`runMigrations` も同じ）。

### ⚠ 接続・ロール・DB の `statement_timeout` などは、migration の本体にも効く

`runMigrations` が戻すのは `lock_timeout` だけである（上の節）。接続文字列の `options`・`PGOPTIONS`・`ALTER ROLE … SET`・`ALTER DATABASE … SET` で渡した
`statement_timeout`・`default_transaction_read_only` などのセッション設定は、migration の本体（`BEGIN` の中の DDL）にそのまま効く。
特に **`statement_timeout` が短いと、時間のかかる DDL（大きい表への `CREATE INDEX` など）が毎回同じところで落ちる**。

- 落ちたときの状態は安全である。【実測】2026-10-01、PostgreSQL 17・ローカル。`CREATE TABLE` のあとに `pg_sleep(2)` を置いた migration 1本を `runMigrations` で流した:
  `statement_timeout=500ms` を `ALTER ROLE`・`ALTER DATABASE`・`PGOPTIONS`・接続文字列の `options` のどれで渡しても、約0.5秒で
  `migration 9001_slow.sql failed: canceling statement due to statement timeout` になり、そのファイルの `CREATE TABLE` は巻き戻り、台帳に行は載らず、
  `idle in transaction` の接続も advisory lock も残らなかった（打ち直せばそのファイルから当たる）。文言は原因が設定であることを言わない。
- **migrate を流す接続だけ、無効にする**（`0` は上限なし）。接続文字列の `options`（CLI もこれで効く）か `PGOPTIONS` で渡すと、ロールの設定より優先される
  （【実測】同じ条件で、`ALTER ROLE … SET statement_timeout='500ms'` のロールに `PGOPTIONS="-c statement_timeout=0"` と `?options=-c%20statement_timeout%3D0` のどちらを
  渡しても、約2秒の migration は成功した）。
  `DATABASE_URL=postgresql://user:pass@host:5432/mydb?options=-c%20statement_timeout%3D0 npx mnemora-postgres-migrate`
  アプリ用の接続のロール・DB に `statement_timeout` を掛けているなら、migrate 専用のロールを別に用意して、そちらには掛けない運用もある。
- `ALTER ROLE … SET lock_timeout` で短い値を掛けたロールで流すと、`RESET lock_timeout` がその値へ戻るので、本体の DDL の表ロック待ちもその値で切れる
  （【実測】別セッションが表を握っている間に流すと、約0.1秒で `canceling statement due to lock timeout`）。上の節の「上限を付ける」と同じ仕組みである。
- `default_transaction_read_only=on` のロールで流すと、台帳の作成（`BEGIN` の外）が `cannot execute CREATE TABLE in a read-only transaction` で落ちる。
  この場合の文言は `migration <file> failed:` で始まらない（本体に入る前に落ちる）。
- **runner が `statement_timeout` を上書きすることはしていない**（既定の振る舞いが変わるため。[ADR 0448](../../docs/decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md) の材料）。

### ⚠ 複数の表を1トランザクションで触る migration（`0027` など）は、アプリの書き込みを止めてから当てる

- `0027_erase_tenant_fk_indexes.sql` は1つのトランザクションで複数の表に `CREATE INDEX` を撃ち、それぞれの表のロックをコミットまで持つ。
  `observe()` も複数の表（`memories` → `memory_events`）に書くので、止めずに当てると **deadlock（`40P01`）になりうる**。
  【実測】2026-10-01、observe・recall・tick を回しながら当てて、5回のうち4回。migrate が犠牲なら `deadlock detected` で失敗してロールバックされ
  （もう一度当てれば適用される）、アプリが犠牲なら `observe()` が `40P01` で落ちる（observation は残り、extract のジョブはリース切れの後に `tick` が拾い直す）。
  詳細は [docs/migration-v1.md](../../docs/migration-v1.md) の `0027` の項目と ADR 0442。
- **未測定**: `0027` 以外で複数の表を1トランザクションで触る migration（`0020`・`0032` など）。同じ形のものも、書き込みを止めてから当てるのが安全である。
- 上の「複数プロセスが同時に実行しても安全（advisory lock で直列化する）」は、migrate どうしの話であり、動いているアプリとの同時実行は約束していない。

### ⚠ 新規インストール後、最初のデータ投入が終わったら `--analyze-memories` を実行すること

**新規インストールの直後は、ANN（近似最近傍）検索が「索引が無いのと同じ遅さ」で動く。**
`migrations/0005_analyze_memories.sql` は `memories` の統計情報を更新する `ANALYZE` を
含むが、このファイルは**他のすべてのマイグレーションと同じく、アプリケーションが最初の
行を書き込む前に**適用される——つまり `0005` が走る時点で `memories` はまだ空であり、
`ANALYZE` は集めるべき行を持たない（詳細と実測は `migrations/0005_analyze_memories.sql`
本文のコメントと [ADR 0062](../../docs/decisions/0062-contested-with-id-fk-index.md) (d) を
参照。実測: 新規インストール順のまま100,000行投入した状態での ANN クエリは
**37.4 / 33.2 / 32.9 ms**——`ANALYZE` 未実行の場合と統計的に同じ遅さ。対して
`ANALYZE` 実行後は **4.6 / 4.5 / 5.6 ms**）。

> **⚠ 追記（2026-09-17、[Issue #425](https://github.com/takecchi/mnemora/issues/425)）— 上の数字は、当時・当条件の記録として読むこと**:
>
> 上の実測には行数（100,000）以外の測定条件（`shared_buffers`・次元数・データ分布など）が
> 記録されておらず、**他の環境では再現できない。**⛔ **そのため数字は書き換えない**
> （[ADR 0213](../../docs/decisions/0213-live-docs-cite-adrs-by-anchor-not-line-number.md) 決定5。
> ここは宛先ではなく主張であり、追記で訂正する対象である）。
>
> 【受】別条件（自分専用の PostgreSQL、100,000行、当日の既定 WHERE 述語）で
> 再測した結果は、絶対値が大きく違った——旧来相当の述語で `ANALYZE` 前 median 261.0ms →
> 後 2.09ms、述語を足した当日の既定形で 167.8ms → 2.25ms。**それでも
> 「`ANALYZE` 前後で桁が違う」という定性的な結論は崩れていない。**

**⟹ 初回のデータ投入（シード・移行元からの一括インポート等）が終わったタイミングで、
一度だけ次を実行すること**（`mnemora-postgres-migrate` と同じバイナリの1オプション、
[ADR 0143](../../docs/decisions/0143-analyze-memories-after-seed.md)）:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate --analyze-memories
```

- 保留中のマイグレーションを適用したうえで、続けて `ANALYZE memories;` を実行する
  （マイグレーションの適用対象が無くても、`--analyze-memories` 単体で実行される）。
- **何度実行しても安全**（冪等）——デプロイの手順書やデプロイ後フックに組み込んでおいて
  差し支えない。`--schema` を指定している場合はそのスキーマの `memories` に対して実行する。
- `MNEMORA_ANALYZE_MEMORIES=1`（空文字・`"0"`・`"false"` 以外の値）でも同じ効果。
- **これは完全な自動化ではない**——`runMigrations`／このマイグレーション自体には
  「データが投入された後」を検知する手段が無いため、実行するタイミングは運用側が
  判断する必要がある。`ANALYZE`（`VACUUM` を伴わない単体の `ANALYZE`）は PostgreSQL の
  公式文書によれば通常の読み書きをブロックしないため、デプロイパイプラインの
  最後や、cron で定期的に呼んでも安全側に倒れる設計である。**【実測】2026-10-01（PostgreSQL 17、
  3000行の `memories`）: `ANALYZE memories` が持つロックは `ShareUpdateExclusiveLock` で、
  それを保持している間の `INSERT`・`UPDATE`・`SELECT` は `lock_timeout = 1s` でも待たされなかった
  （数 ms）。逆に、未コミットの `INSERT`・`UPDATE` がある最中の `ANALYZE memories` も待たされなかった。**
  **確かめていないこと**: 3000行より大きい表（`ANALYZE` 自体の所要時間は表の大きさで伸びる。3000行で25ms）、
  `autovacuum` との重なり、別の `ANALYZE`・`VACUUM` との重なり（`ShareUpdateExclusiveLock` どうしは待ち合う
  ——対照で確かめた）。詳細・
  採らなかった案・確かめていないことは
  [ADR 0143](../../docs/decisions/0143-analyze-memories-after-seed.md) 参照。

> **⚠ 追記（2026-09-24、[Issue #269](https://github.com/takecchi/mnemora/issues/269) 方向4）— 書き込み経路の自動 `ANALYZE` との関係**:
>
> その後、`PostgresMemoryStore` を通る書き込み（`createMemory` / `createMemoryWithOutbox` /
> `supersedeWithNewMemories`）は、統計が実態より遅れているときだけ `ANALYZE memories` を
> 自分で打つようになった（[ADR 0221](../../docs/decisions/0221-memories-analyze-on-write.md)・
> [ADR 0225](../../docs/decisions/0225-supersede-with-new-memories-analyze-hook.md)）。
> ⟹ **`--analyze-memories` が要らなくなったのではない。** `PostgresMemoryStore` を通らない
> 一括投入（SQL を直接流す・`pg_restore`・`INSERT ... SELECT` など）には、自動の判定は
> 効かない。**初回の投入の後に一度打つ手順は、これまでどおり残すこと。** 何度打っても
> 安全なので、デプロイの手順やデプロイ後フックに入れておけば、どの経路で投入したかを
> 気にしなくてよい（例示は下の `scripts` と、[`examples/chat`](../../examples/chat/README.md)
> の導入手順）。
>
> **⚠ 多プロセスで動かすとき**: この自動 `ANALYZE` の「書いた行数」の数えは、**プロセスごと**
> （モジュールスコープの `Map`。`memories` も `memory_embeddings_*` も同じ）で、プロセス間で
> 共有しない。閾値（1,000 / 2,000 / 4,000 / …）に届くのは「そのプロセスが書いた累計」であって、
> テーブル全体の行数ではない。⟹ 書き込みを N プロセスに散らすと累計が N 個に割れ、全体では
> 閾値の数倍の行を書いても、どのプロセスも閾値に届かず、自動の `ANALYZE` が打たれないことがある
> （プロセスの寿命が短い運用——ジョブごとに起動して数百件だけ書く、など——は特にそう）。
> 逆に、各プロセスが自分の閾値で `pg_class.reltuples` を読むので、同じ頃に複数のプロセスが
> `ANALYZE` を打つこともありうる。**多プロセス運用では自動の `ANALYZE` に頼り切らず、上の
> `--analyze-memories` を投入後・デプロイ後に打つこと。**【現物】【未確認】: コードを読んでの記述で、
> 複数プロセスで打たれる頻度は測っていない（[ADR 0460](../../docs/decisions/0460-multi-process-multi-pool-round33.md)
> D5）。

> **⚠ 追記（2026-09-27、[Issue #1181](https://github.com/takecchi/mnemora/issues/1181)）— 入れ始めの小さい DB では、連想枠（既定 on）の recall も遅くなる**:
>
> 空の DB に記憶を入れ始めたばかり（数百行）で、`memories` にも埋め込み表にもまだ統計が無いと、
> 連想枠（段3.5、既定 on）がアンカーごとの ANN 検索を束ねる問い合わせ（`PostgresVectorStore.searchMany`）が、
> memories を主キーで引かないプランになる。【実測】200行・64次元で、recall 全体が
> 統計なし 63 ms、`ANALYZE` の後 18 ms（その問い合わせ単体では 28 ms → 1.4 ms）。
> この規模では、書き込み経路の自動の `ANALYZE`（上の追記）はまだ打たれない。
> ⟹ **上の `--analyze-memories`（`ANALYZE memories;`）を1回打てば戻る**（【実測】`memories` だけの
> `ANALYZE` で、その問い合わせは 1.8 ms。埋め込み表だけでも 1.4 ms）。数百行を超えると、統計が無くても
> 上乗せは小さくなった（500〜900行で 5〜8 ms）。詳細と、確かめていないことは Issue #1181。
>
> ⚠ **2026-10 追記（[ADR 0362](../../docs/decisions/0362-searchmany-lateral-forces-memories-primary-key-lookup.md)・
> [ADR 0374](../../docs/decisions/0374-search-stats-presence-instance-cache.md)）: 上の遅さは直った。**
> `PostgresVectorStore` は `search`・`searchMany` とも、統計が無い表では `memories` を主キーで引く形に切り替える
> （インスタンスが表ごとに統計の有無を一度だけ確かめて覚える）。上の実測（63 ms → 18 ms）は直す前の数字で、
> 今は `--analyze-memories` を打たなくても、この理由では遅くならない。投入後に `--analyze-memories` を打つ勧めは、
> 上の節のとおり（プランの統計一般のため）変わらない。

### 専用スキーマを指定する（`--schema` / `--extension-schema`）

共有 DB に他システム（例: Prisma が管理する `public`）が同居していて、mnemora の
テーブル群を別スキーマへ隔離したい場合は、`--schema` を指定する。ライブラリ側の
`runMigrations` の `options.schema` / `options.extensionSchema`
（[`src/schema-namespace.ts`](./src/schema-namespace.ts) の `SchemaNamespaceOptions`）を
そのまま CLI から渡せる口である。

```bash
# コマンドライン引数（--schema=<name> の = 区切りでも可）
npx mnemora-postgres-migrate --schema tenant_a --extension-schema public

# 環境変数（CI・コンテナから渡しやすい）
MNEMORA_SCHEMA=tenant_a MNEMORA_EXTENSION_SCHEMA=public npx mnemora-postgres-migrate

# --help で使い方・引数・環境変数・優先順位を確認できる
npx mnemora-postgres-migrate --help
```

- **優先順位はコマンドライン引数が勝つ**: `--schema` > `MNEMORA_SCHEMA` > 未指定、
  `--extension-schema` > `MNEMORA_EXTENSION_SCHEMA` > 未指定。
- **どちらも指定しなければ、今日と1バイトも変わらない**（`runMigrations(pool)` 相当。
  `search_path` 任せの既定経路）。
- `--extension-schema`（`MNEMORA_EXTENSION_SCHEMA`）は `schema` 側
  （`--schema` または `MNEMORA_SCHEMA`）が最終的に指定されているときだけ効く。
  `schema` 無しで `--extension-schema` だけを指定するとエラー（終了コード 1）になる
  ——黙って無視すると「拡張の置き場所を変えたつもりで実は変わっていない」という
  気付きにくい事故になるため。
- `--extension-mode <create|verify>`（`MNEMORA_EXTENSION_MODE`）は3拡張の用意のしかたを選ぶ
  （[ADR 0093](../../docs/decisions/0093-extension-verify-mode.md)）。`create`（既定）は
  `CREATE EXTENSION IF NOT EXISTS` を発行する。`verify` は何も発行せず `pg_extension` を読み、
  足りない拡張があれば拡張名と実行すべき SQL を示して失敗する（`CREATE EXTENSION` 権限を
  持たないロール向け）。`--schema` の有無に関わらず指定できる。`create` / `verify` 以外の値は
  エラー（終了コード 1）になる。
- 不正なスキーマ名（PostgreSQL の識別子として使えない・63バイト超）や未知の引数、
  値の無い `--schema` もエラー（終了コード 1）で止まる。
- 環境変数を空文字にしても「未指定」にはならない（今の振る舞い）: `MNEMORA_SCHEMA=`・`MNEMORA_EXTENSION_SCHEMA=`・`MNEMORA_EXTENSION_MODE=` は、どれもエラー（終了コード 1）になる。空文字を偽として扱うのは `MNEMORA_ANALYZE_MEMORIES` だけである。

`package.json` の `scripts` に組み込む例:

```json
{
  "scripts": {
    "migrate": "mnemora-postgres-migrate",
    "migrate:analyze": "mnemora-postgres-migrate --analyze-memories"
  }
}
```

`migrate:analyze` は、初回のデータ投入が終わった後と、デプロイの最後に打つ（上の
「⚠ 新規インストール後、最初のデータ投入が終わったら `--analyze-memories` を実行すること」）。

## 動く最小の例（CI の門では検査していない）

```ts
import {
  createPostgresClient,
  registerEmbeddingSpace,
  PostgresMemoryStore,
  PostgresVectorStore,
  PostgresEventStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
} from "@mnemora/postgres";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import { createRuntime } from "@mnemora/core";
import { createHash } from "node:crypto";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL が設定されていません。");
}

const client = createPostgresClient(connectionString);

const embeddingProvider = new OpenAIEmbeddingProvider({
  model: "text-embedding-3-small",
  dimensions: 1536,
});

// 埋め込み空間ごとのテーブルは、先に registerEmbeddingSpace で作っておく必要がある
// （未登録の空間に PostgresVectorStore.upsert などを呼ぶと EmbeddingSpaceNotRegisteredError で失敗する。ADR 0433）。
await registerEmbeddingSpace(client.pool, embeddingProvider.space);

const runtime = createRuntime({
  memoryStore: new PostgresMemoryStore(client.db),
  vectorStore: new PostgresVectorStore(client.db),
  eventStore: new PostgresEventStore(client.db),
  outboxStore: new PostgresOutboxStore(client.db),
  tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
  llmProvider: new OpenAILLMProvider({ model: "gpt-4o-mini" }),
  embeddingProvider,
  hashContent: (content) => createHash("sha256").update(content).digest("hex"),
});

const ctx = { tenantId: "tenant-1" };
await runtime.observe(ctx, {
  kind: "utterance",
  text: "明日、京都へ出張する",
  speaker: "user",
});

// observe は outbox に積むだけ。索引づけは tick が行う（tick 無しで recall すると memories は空）
await runtime.tick(ctx, { leaseMs: 30_000 });
const recalled = await runtime.recall(ctx, { text: "京都の予定は?" });
console.log(recalled.memories.length);
```

⚠ **`observe()` は記憶を outbox に積むだけで、索引づけ（埋め込み）は `tick()` が行う。**`tick()` を呼ばずに `recall()` すると、`memories: []` が返り、`omitted` に `not_indexed`（`reason: "pending"`）が出る（インメモリの store と `@mnemora/testkit` の決定的な provider で、tick 無しは空・tick を1回呼ぶと1件返ることを確かめた）。常駐のワーカーが `tick()` を回す構成では、この1行は要らない（[`@mnemora/bullmq`](../bullmq/README.md)）。`leaseMs`（ジョブを掴む時間）は必須。

上のコードを動かす前に、`mnemora-postgres-migrate` で該当 DB にスキーマを適用しておくこと。

⚠ この例には `ts check` の印を付けていない。`pnpm check:doc-snippets` はこの README の片を `packages/postgres` から解決し、このパッケージは `@mnemora/openai` に依存していないので、印を付けると `@mnemora/openai` が見つからずに落ちる。`examples/chat`（`@mnemora/openai` にも依存している）を起点にすれば型検査は通る（2026-09-28、main fd74b23 で確かめた）。⟹ **この例が今の公開 API で型検査に通ることを、CI は確かめていない。**

⚠ 2026-09-27 追記: 当時の見出しにあった「DB へは未実行」は、その時点の記録である。`pnpm pack` した tarball を repo の外の空のプロジェクトに入れ、`npx mnemora-postgres-migrate` の後に、この例の LLM・埋め込みだけを `@mnemora/testkit` の決定的な provider に差し替えて Postgres 17 + pgvector に対して走らせ、observe → tick → recall が通ることを確かめた。例そのまま（OpenAI）は鍵を要るので走らせていない——鍵が無いと `new OpenAIEmbeddingProvider(...)` の時点で OpenAI の SDK が `Missing credentials` で止まる。

## `PostgresRelationStore` を配線する（3件以上の主張の衝突を群にする）

**省略しても mnemora は成立する。**上の最小の例は `PostgresRelationStore` を渡していない。渡すと、
`runtime.observe()` の主張キーの衝突検出（`claimKey: { enabled: true, detectContested: true }`）で、
同じ claim key に3件以上の主張が来たとき、`memory_relations` で束ねた `contested` の群を作る
（[ADR 0381](../../docs/decisions/0381-contested-group-write-path-implementation.md)）。
渡す先は `createRuntime` の `relationStore` である。

```ts check
import { createRuntime } from "@mnemora/core";
import type { EmbeddingProvider, LLMProvider } from "@mnemora/core";
import {
  createPostgresClient,
  PostgresMemoryStore,
  PostgresVectorStore,
  PostgresEventStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresRelationStore,
} from "@mnemora/postgres";
import { createHash } from "node:crypto";

// 上の最小の例と同じ LLM・埋め込みの provider（registerEmbeddingSpace も同じく先に済ませておく）。
declare const llmProvider: LLMProvider;
declare const embeddingProvider: EmbeddingProvider;

const client = createPostgresClient(process.env.DATABASE_URL ?? "");

const groupRuntime = createRuntime({
  memoryStore: new PostgresMemoryStore(client.db),
  vectorStore: new PostgresVectorStore(client.db),
  eventStore: new PostgresEventStore(client.db),
  outboxStore: new PostgresOutboxStore(client.db),
  tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
  relationStore: new PostgresRelationStore(client.db), // ← これを足す
  llmProvider,
  embeddingProvider,
  hashContent: (content) => createHash("sha256").update(content).digest("hex"),
});

// 衝突検出は observe の呼び出しごとの opt-in。配線しただけでは検出は走らない。
const observed = await groupRuntime.observe(
  { tenantId: "tenant-1" },
  {
    kind: "utterance",
    text: "今は福岡に住んでいる",
    speaker: "user",
    claimKey: { enabled: true, detectContested: true },
  },
);

for (const outcome of observed.contestedDetection ?? []) {
  if (outcome.result.kind === "contested_group") {
    // 3件以上が status = 'contested' の群になった。
    console.log(outcome.result.memberIds);
  } else if (outcome.result.kind === "unresolved_conflict") {
    // 記録しただけ（下の表）。status は動いていない。
    console.log(outcome.result.matchMemoryIds);
  }
}
```

**recall 側の効果**: 群のメンバーは単独では返らず、`RuntimeDeps.relationStore` を辿って仲間を同伴して返す
（上限・`over_limit { stage: "relation" }` は [docs/recall.md](../../docs/recall.md) の段3と ADR 0381 §5）。
配線しないと、群のメンバーは今までどおり `unit_assembly_dropped` に落ちる。
⚠ 群は `relationStore` 無しでも存在しうる（`Runtime.markContestedGroup` は配線しない runtime からも呼べ、群を書いた runtime と recall する runtime とで配線が違うこともある）。そのとき recall では同伴だけでなく**群のヒット自身も**落ち、3件以上の群のメンバーだけがヒットした recall では、群のヒットが1件だけのときも、返る件数は0件になる（【実測 2026-10-01】この package と `@mnemora/testkit` の InMemory の両方。[ADR 0327](../../docs/decisions/0327-relation-graph-contested-write-path-design.md) 末尾の 2026-10-01 追記）。

### 3件目以降が「記録するだけ」で止まる条件

主張キーの衝突検出は `Runtime.observe()` 内の `detectClaimKeyContested`
（`packages/core/src/runtime.ts`）が行う。一致が2件以上、または1件でもそれが既に `contested` のとき、
次のどれかなら `status` は動かず、根拠だけを残す。

| 条件                                                                                                                                          | 現物                                                                                                                                                                                     | 呼び出し側に見えるもの                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `relationStore` を配線していない                                                                                                              | `detectClaimKeyContested` 内の `deps.relationStore !== undefined && deps.memoryStore.markContestedGroup !== undefined`（群を作る分岐に入る条件の前半）                                   | `contestedDetection[].result` が `{ kind: "unresolved_conflict", matchMemoryIds }`（同関数が `kind: "unresolved_conflict", matchMemoryIds: matches` を返す末尾）。`memory_events` に `kind: "updated"`・`meta.reason: "claim_key_conflict_unresolved"` の行が1件積まれる |
| `memoryStore.markContestedGroup` が無い adapter                                                                                               | 上と同じ条件の後半 `deps.memoryStore.markContestedGroup !== undefined`（`PostgresMemoryStore` は `packages/postgres/src/memory-store.ts` の `async markContestedGroup(` で実装している） | 同上                                                                                                                                                                                                                                                                     |
| 組み立てた群が3件未満                                                                                                                         | `memberIdSet.size >= 3`（`runtime.ts`）                                                                                                                                                  | 同上                                                                                                                                                                                                                                                                     |
| `markContestedGroup` が `contested_group` 以外（`ineligible` / `conflict`）を返した                                                           | `markResult.outcome.kind === "contested_group"`（`runtime.ts`。このときだけ `groupOutcome` に入り、群として返す）                                                                        | 同上                                                                                                                                                                                                                                                                     |
| （recall の側。上の4行とは違い、observe で群が作られた**後**の条件）群は DB に在るが、recall する runtime に `relationStore` を配線していない | `packages/core/src/recall-runtime.ts` の段3・段4（`contestedWithId` の無い `contested` 候補は仲間を辿れず、単位を組めない。`RecallRuntimeDeps.relationStore` の TSDoc）                  | その recall で、群のメンバーは同伴もヒット自身も返らない。`omitted` に `stage_skipped { stage: "relation", reason: "relation_store_unavailable" }` と `unit_assembly_dropped`（群のヒットの件数）が出る。`status` は動かない（群のまま）                                 |

- `memory_events` の根拠（`note` の JSON）には claim key・新しい Memory・一致した Memory の `status`/`contentHash`/有効期間が入る。
  一致した Memory が複数になる根拠（群と、記録だけで止まる場合）では、一致した Memory は **id の昇順の先頭 10 件**（`runtime.ts` の `CONTESTED_GROUP_NOTE_SAMPLE_LIMIT`）だけが入り、
  全件の数が `matchCount`、切り詰めたかが `matchesTruncated` に付く（[ADR 0431](../../docs/decisions/0431-contested-group-event-growth-and-recall-cut.md)）。
- `superseded` へは進めない。
- **`detectContested` を渡さない（または `false`）と、検出そのものが走らない**——上の「記録するだけ」ですらなく、
  `memory_events` の根拠も積まれず、`ObserveResult.contestedDetection` の欄自体が無い（`undefined`。`runtime.ts` の `claimKeyOptions?.detectContested === true` と `input.claimKey?.detectContested === true ? { contestedDetection }`）。
  `claimKey.enabled: true` も要る（無いと Memory に claim key が付かず、検出は `null` を返す。`detectClaimKeyContested` 冒頭の `const claimKey = memory.claimKey ?? null;`）。
- ちょうど1件の `active` な一致は、配線に関わらず2者間の `contested`（`kind: "contested"`）になる（`detectClaimKeyContested` の `matches.length === 1 && matches[0]!.status === "active"` の分岐）。

## adapter として自作する場合

`MemoryStore` 等の自作実装を書くなら、[`@mnemora/testkit`](../testkit/README.md) の
適合テスト（conformance suite）に食わせて検査できる。`@mnemora/postgres` 自身の実装も
この適合テストで検査している。

## この package が作るオブジェクト（共有 DB へ入れる前に確認すること）

**mnemora を、他のアプリと同じ Postgres データベースへ同居させる場合**は、
下の名前が既存のオブジェクトと衝突しないか、導入前に確認すること。専用スキーマへ
隔離したい場合は上の「専用スキーマを指定する」を見ること（テーブル・索引は
`--schema` で指定したスキーマの下に作られる。advisory lock のキーは
「advisory lock のキー」の節を見ること）。

**この一覧は自動生成ではない。**`packages/postgres/migrations/*.sql` を
ファイル名順に適用した最終形として人手で導出し、
[`scripts/__tests__/readme-postgres-objects.test.mjs`](../../scripts/__tests__/readme-postgres-objects.test.mjs)
（[`scripts/readme-postgres-objects-lib.mjs`](../../scripts/readme-postgres-objects-lib.mjs)）が
migrations と `src/` の現物から機械的に導いた集合と突き合わせている。**この一覧が
CI で赤くなったら、コードではなくこの一覧のほうを直すこと**（歯が正、この文章が従。
導出のやり方・DROP された索引を数えない理由は [ADR 0202](../../docs/decisions/0202-postgres-shared-db-object-names.md) 参照。**関数**（`CREATE FUNCTION` /
`CREATE OR REPLACE FUNCTION`）も含めて突き合わせている——
[ADR 0204](../../docs/decisions/0204-postgres-object-names-cover-functions.md) が
ADR 0202 の「引き受けた負債1」を解消した）。

### テーブル（12）

- `labels`
- `memories`
- `memory_events`
- `memory_labels`
- `memory_relations`
- `observations`
- `outbox`
- `recall_usages`
- `recalls`
- `tenant_activity`
- `tenant_settings`
- `tenant_subject_activity`

### 索引（40）

- `idx_labels_by_status`
- `idx_memories_attributes`
- `idx_memories_by_subject`
- `idx_memories_claim_key`
- `idx_memories_claim_predicates`
- `idx_memories_contested`
- `idx_memories_contested_with`
- `idx_memories_digest_band`
- `idx_memories_lexical`
- `idx_memories_period_ann_stage`
- `idx_memories_provenance_kind`
- `idx_memories_recall_gate`
- `idx_memories_recall_gate_seq`
- `idx_memories_requeue_embed`
- `idx_memories_source_observation_id`
- `idx_memories_superseded_by`
- `idx_memories_superseded_by_id`
- `idx_memories_tags`
- `idx_memory_events_by_kind`
- `idx_memory_events_by_memory`
- `idx_memory_events_by_retention`
- `idx_memory_events_memory_id`
- `idx_memory_labels_by_label`
- `idx_memory_labels_label_id`
- `idx_memory_labels_memory_id`
- `idx_memory_relations_from`
- `idx_memory_relations_from_memory_id`
- `idx_memory_relations_to`
- `idx_memory_relations_to_memory_id`
- `idx_observations_by_subject`
- `idx_outbox_claimable`
- `idx_outbox_completed`
- `idx_outbox_pending`
- `idx_recall_usages_memory_id`
- `idx_recall_usages_recall_id`
- `idx_recalls_by_created`
- `idx_recalls_by_subject`
- `idx_recalls_digest_band`
- `uq_memories_extraction`
- `uq_observations_external_id`

### 関数（6）

- `mnemora_lexical_coverage`
- `mnemora_lexical_normalize`
- `mnemora_lexical_query_or`
- `mnemora_lexical_query_terms`
- `mnemora_lexical_query_tsqueries`
- `mnemora_lexical_tsvector`

⚠ **引数シグネチャ（`(text)` 等）までは検査していない。**`CREATE OR REPLACE FUNCTION`
で同名を別シグネチャに置き換えても、この歯は気づかない
（[ADR 0204](../../docs/decisions/0204-postgres-object-names-cover-functions.md)「引き受けた負債」1番）。

**なぜこれを埋めずに据え置くのか。**「起きうるから塞ぐ」ではなく、履歴を引いて決めた
（`main` = `d0ce4b3a497ab7218495683ba2f343b4cf22701e` 時点の【実測】）:

- `mnemora_lexical_*` の5関数はすべて `CREATE FUNCTION`（`OR REPLACE` ではない）で、
  それぞれ1回しか定義されていない。
- 定義元の2ファイル（`migrations/0008_memories_lexical_index.sql` /
  `migrations/0009_memories_lexical_or_coverage.sql`）は、それぞれ追加した commit
  （`0a71a57` / `251e4d7`）以降**一度も変更されていない**。
- `git log --all -S'CREATE OR REPLACE FUNCTION' -- packages/postgres/migrations/` は
  **0件**——`CREATE OR REPLACE FUNCTION` はこのリポジトリの履歴に一度も現れていない。
- `packages/postgres/migrations/`（17本）のうち、追加後に変更されたファイルは
  `0011_memory_events_kind_restored.sql` の1本だけで、その変更（commit `f15130b`、
  Issue #227 / PR #236）は**説明コメントの修正**であり、関数定義にもシグネチャにも
  無関係だった。

⟹ **シグネチャが変わった実績は0件。**名前だけを見る形を、今回は据え置く。

⚠ **それでも正直に書いておくこと**: 共有 DB での衝突検査という目的に照らすと、
PostgreSQL は**同名・別シグネチャの多重定義（オーバーロード）を許す**ため、
名前だけの一致では衝突を厳密には判定しきれない。**それでも名前が一致すること自体は
「調べるべき合図」としては十分**であり、この歯が拾った一致をレビューで見る、という
運用でその限界を補っている。これが覆るとしたら、mnemora が実際にオーバーロードを
使い始めたときである（ADR 0204「これが覆るとしたら」）。

⚠ **2026-09-27 追記**: 上の「`CREATE OR REPLACE FUNCTION` はこのリポジトリの履歴に一度も現れていない」は、
`migrations/0023_lexical_query_inner_quote_as_space.sql` で事実でなくなった——`mnemora_lexical_query_tsqueries`
を `CREATE OR REPLACE FUNCTION` で置き換えている（語の途中の `"` を空白として扱う修正）。**引数・戻り値の
シグネチャ（`(text) RETURNS tsquery[]`）は 0009 と同じ**で、同名・別シグネチャの多重定義は作っていない
（関数は5つのまま）。⟹ 名前だけを見る形を据え置く判断（ADR 0204「引き受けた負債」1番）は変えていない。

⚠ **2026-09-29 追記**: `migrations/0025_lexical_tsvector_fallback.sql`（Issue #1222、ADR 0364）が
`mnemora_lexical_tsvector(text) RETURNS tsvector`（`LANGUAGE plpgsql`）を1本足した——`CREATE FUNCTION`
（`OR REPLACE` ではない、上の判断が対象にしている形のまま）で、以後変更していない。**関数は6つになった**
（上の「5関数」という当時の実測件数は、この commit より前の履歴を指すものとして書き換えていない）。
シグネチャの重複は無く、⟹ 名前だけを見る形を据え置く判断は変えていない。

### opt-in で作られるもの（トライグラム経路）

**上の「テーブル」「索引」「関数」の一覧には含まれない**（見出しの件数にも数えない）。次のオブジェクトは
`migrations/*.sql` では**作られない**——`PostgresTrigramLexicalStore`
（[ADR 0319](../../docs/decisions/0319-optional-trigram-lexical-store.md)）を使うと決めた採用者が、
下の口を呼んだときにだけ作られる（[`src/trigram-lexical-store.ts`](./src/trigram-lexical-store.ts)）。
使わなければ、この3関数も索引も共有 DB に現れない。

関数（`ensureTrigramLexicalFunctions`。`CREATE OR REPLACE FUNCTION`、冪等。
`PostgresTrigramLexicalStore.create()` が内部で呼ぶ）:

- `mnemora_trigram_query_nonascii`
- `mnemora_trigram_strip_noise`
- `mnemora_trigram_hybrid_coverage`

索引（**関数のインストールとは別の口**。`create()` は張らない。呼ばなくても検索は正しい結果を返し、
Seq Scan になるだけ）:

- `idx_memories_trigram` ——`memories` の `gin (tenant_id, content gin_trgm_ops)`
  （`WHERE status IN ('active', 'contested')` の部分索引）。
  - `createOptionalTrigramIndex`: 素の `CREATE INDEX IF NOT EXISTS`（書き込みを止めうる）。
  - `createOptionalTrigramIndexConcurrently`: 同じ名前・同じ形を `CREATE INDEX CONCURRENTLY` で張る
    （**トランザクションの外で呼ぶこと**。INVALID な同名索引が残っていれば消して作り直す）。

**この節は、上の突き合わせの歯（`scripts/readme-postgres-objects-lib.mjs`）が読まない**
（`parseReadmeObjectsSection` は `テーブル` / `索引` / `関数` で始まる見出しの節だけを読み、
この節の見出しはどれでも始まらない。migrations の集合とも突き合わせない）。
名前が `src/trigram-lexical-store.ts` で変わったら、この節は人手で直すこと。

### 実行時に増える系列（埋め込み空間ごと）

`registerEmbeddingSpace` を呼ぶたびに、その `EmbeddingSpaceId`
（`(provider, model, dimensions)`）ごとに次の名前が1組ずつ増える
（[`src/embedding-space-table.ts`](./src/embedding-space-table.ts)）:

- テーブル: `memory_embeddings_<space>`
- 索引（HNSW）: `idx_memory_embeddings_hnsw_<space>`
- 索引（ゼロベクトル用の部分索引、Issue #956 / ADR 0343）: `idx_memory_embeddings_zero_norm_<space>`
- 索引（`(memory_id)` 単一列、Issue #1207 / ADR 0383）: `idx_memory_embeddings_memory_id_<space>`
  ——`memories` の行を削除するたびに走る参照整合性チェックのための索引。既存の空間には
  `migrations/0027_erase_tenant_fk_indexes.sql` の `DO` ブロックが遡って作る（上の
  「索引」の見出しの数には含めない——動的な `EXECUTE format(...)` で作るため、この README を
  生成する道具が静的な `CREATE INDEX` としては数えない。[ADR 0202](../../docs/decisions/0202-postgres-shared-db-object-names.md) と同じ扱い）。

`<space>` は `provider` / `model` / `dimensions` を小文字化・非英数字を `_` に置換して
連結したスラグ（例: `openai_text_embedding_3_small_1536`）。**PostgreSQL の識別子は
63バイトまで**のため、これを超える場合は末尾を切り詰め、内容から導いたハッシュ片
（8桁の16進）を足して衝突を避ける（[`src/embedding-space-table.ts`](./src/embedding-space-table.ts)、
検査は
[`src/__tests__/embedding-space-table.test.ts`](./src/__tests__/embedding-space-table.test.ts)）。

🔴 **索引のほうがテーブルより先に頭打ちになる。**接頭辞の長さが違うため
（【実測】）:

- テーブルの接頭辞 `memory_embeddings_` = **18バイト** ⟹ スラグに使える余地は63−18=**45バイト**
- 索引の接頭辞 `idx_memory_embeddings_hnsw_` = **27バイト** ⟹ スラグに使える余地は63−27=**36バイト**

⟹ **索引のほうが9バイト早く上限に達する。**同じ `<space>` でも、テーブルはまだ
切り詰められていないのに索引だけ切り詰められる、という組み合わせが起こりうる。

**いま使われている中で最長の空間**（`openai` / `text-embedding-3-small` / `1536`。
`docs/memory-model.md` §10・この README の「動く最小の例」・`packages/openai/README.md`
が挙げている組）は、索引名が
`idx_memory_embeddings_hnsw_openai_text_embedding_3_small_1536`（**61バイト**）
——**上限まであと2バイト**しかない。

🔴 **実際に切り詰めが起きる具体例**（`provider`/`model` は
[`packages/core/src/embedding.ts`](../core/src/embedding.ts) の
`EmbeddingSpaceId`（`z.string().min(1)`）で長さの上限を設けていないため、
採用者が普通に踏みうる長さ）: `azure-openai` / `text-embedding-3-large` / `3072` では

- テーブル = `memory_embeddings_azure_openai_text_embedding_3_large_3072`
  （**58バイト、切り詰めなし**）
- 索引 = `idx_memory_embeddings_hnsw_azure_openai_text_embedding_eb32c67b`
  （**63バイト、末尾を切り詰めてハッシュ片を付与済み**）

**⟹ この README がここまで書いていた「索引（HNSW）: `idx_memory_embeddings_hnsw_<space>`」
という規則（＝テーブルと同じ `<space>` が付く）は、この場合には成立しない**
——索引名の末尾はテーブル名の `<space>` とは異なる、独自に切り詰められた文字列になる。
⚠ **この歯は接頭辞の一致と63バイト以内であることまでは検査しているが、
「切り詰め・ハッシュ付与が実際に起きたときの具体名がテーブルと索引で食い違いうる」
ことをここに明記するのが今回の変更である**（ADR 0202「引き受けた負債」2番を、
実測に基づいて埋めた）。

🔴 **ゼロベクトル用の部分索引の接頭辞（`idx_memory_embeddings_zero_norm_` = 33バイト）は
HNSW 索引の接頭辞（27バイト）よりさらに6バイト長い**——同じ `<space>` でも、HNSW 索引が
まだ切り詰められない大きさでも、この部分索引は先に切り詰められうる（実測は
[`src/__tests__/embedding-space-table.test.ts`](./src/__tests__/embedding-space-table.test.ts)
の `embeddingSpaceZeroNormIndexName` の節を参照）。この索引は `registerEmbeddingSpace`
が呼ばれるたびに `CREATE INDEX IF NOT EXISTS` で作られる——HNSW 索引と同じ経路であり、
既存の空間（この索引を持たないまま運用されてきたもの）にも、次回 `registerEmbeddingSpace`
が呼ばれたとき（通常はプロセスの再起動時）に同様に作られる。詳細・build 時間の実測は
[ADR 0343](../../docs/decisions/0343-vector-store-search-returns-zero-norm-candidates.md)。

⚠ 2026-09-27 追記（文書と実装の照合、main 16976ea）: 上の段落は `registerEmbeddingSpace` の経路だけを書いている。既存の空間の表には、migration `0022_embedding_zero_norm_index.sql` も `runMigrations` の時点で同じ名前の索引を作る（今のスキーマの埋め込み表を列挙し、`embeddingSpaceZeroNormIndexName` と同じ規則で名前を作る）。どちらが先に作っても、名前が同じなので2本目はできない。

### advisory lock のキー

`runMigrations`（マイグレーション適用）と `registerEmbeddingSpace`
（埋め込み空間ごとのテーブル作成）は、それぞれ別の `pg_advisory_lock` キーで
プロセス間排他を行う（`runMigrations` は、拡張を作る段だけ、下の共有キーも追加で取る）（[`src/migrate.ts`](./src/migrate.ts)・
[`src/vector-space.ts`](./src/vector-space.ts)）。**`pg_advisory_lock` のキー空間は
データベース全体で共有される**——同じ DB の別アプリが同じ数値をキーに使っていると
無関係な処理同士が意図せずブロックし合う。

- `--schema` 未指定、または `--schema public`: 固定の既定キーを使う。
  - `runMigrations`: `7190158676462701299`（`MIGRATION_LOCK_KEY`）
  - `registerEmbeddingSpace`: `-4359922960011245935`（`REGISTER_EMBEDDING_SPACE_LOCK_KEY`）
- それ以外の `--schema <name>` を指定した場合: 固定値ではなく、次のシード文字列を
  sha256 でハッシュして導出した値になる（`deriveAdvisoryLockKey`）。
  - `runMigrations`: シード `mnemora:runMigrations:advisory-lock:<schema>`
  - `registerEmbeddingSpace`: シード `mnemora:registerEmbeddingSpace:advisory-lock:<schema>`
- 拡張を作る段（`extensionMode: "create"`（既定）で、`CREATE EXTENSION` を含むマイグレーションを流す間だけ）:
  `--schema` によらず固定の `-1670586062650017388`（`EXTENSION_LOCK_KEY`）。上の schema ごとのキーに**追加で**取る
  2本目のロックである。拡張は DB 全体に1つしか置けないので、schema の違う `runMigrations` 同士もここで待ち合う
  （[Issue #757](https://github.com/takecchi/mnemora/issues/757)・[ADR 0331](../../docs/decisions/0331-extension-creation-shared-advisory-lock.md)）。
  適用済みの2回目以降の呼び出しと `extensionMode: "verify"` は、このキーを一切取らない。

> **⚠ `--schema` を省略するときは、接続ロール名と同じ名前のスキーマを DB に作らないこと**
> （[Issue #779](https://github.com/takecchi/mnemora/issues/779)）:
>
> `--schema` を省略すると（上の「専用スキーマを指定する」の通り）接続の `search_path` には
> 一切触らない。PostgreSQL の既定の `search_path` は `"$user", public` なので、
> **接続に使ったロール名と同じ名前のスキーマが DB 内に存在すると、`"$user"` がそちらへ
> 解決され、`--schema` を指定していないのに例外も出さずそのスキーマへ読み書きする**
> （`runMigrations` はロール名のスキーマの台帳を適用済みと誤判定し、`applied: []` を
> 返して `public` には一切触れずに成功する）。
>
> ロックキーの食い違いは直っている: `--schema` 省略かつテスト用の `lockKey` 上書きも
> 無い呼び出しは、ロック取得より前に同じ接続で `SELECT current_schema()` を読み、
> その結果で上の「未指定、または `--schema public`」／「それ以外の `--schema <name>`」の
> どちらのキーを使うか決める。ロール名と同名のスキーマが在れば導出キー側になり、
> `--schema <ロール名>` を明示指定した別の呼び出しと同じキーになって互いを待つ
> （[ADR 0331](../../docs/decisions/0331-extension-creation-shared-advisory-lock.md) 追記）。
> ただし**新旧バージョンの混在中**（ローリングデプロイの途中で、この修正が入る前の
> バージョンと後のバージョンが同時に動いている場合）は、旧バージョンが常に固定キーを
> 使うため、その組み合わせに限り互いを待たない窓が残る。
>
> **回避策**: `--schema` を明示するか、接続に使うロールと同じ名前のスキーマを
> DB 内に作らない（データが意図しないスキーマへ読み書きされること自体は、`--schema` を
> 省略している限り変わらない）。挙動・既定値はどちらも変えていない——詳細は
> [Issue #779](https://github.com/takecchi/mnemora/issues/779)・
> [ADR 0057](../../docs/decisions/0057-dedicated-schema-namespace.md) 決定6・
> [ADR 0331](../../docs/decisions/0331-extension-creation-shared-advisory-lock.md)
> 「引き受ける負債」・追記参照。

## pool の `error`: 既定で名乗り、`onPoolError`/自分の `pool.on` で黙らせる

`createPostgresClient` が作る `pool`（node-postgres の `Pool`）には、**常に `error` リスナーが1つ付いている。**
**pool の中で待機している接続が DB 側から切られると**（Postgres の再起動・フェイルオーバー・運用者による切断など）、
`Pool` が `error` イベントを出す——**以前はここにリスナーが無く、Node のプロセスごと落ちていた**（下の「2026-09-29
追記」参照）。**いまは落ちない。** mnemora の呼び出しが1本も進んでいないときに切られても同じである
【実測 2026-09-27、`pg_ctl restart -m fast`】。

既定の振る舞い: 切れた接続は pool から捨てられ、次の呼び出しは新しい接続で通る（`idle in transaction` も残らない。
`src/__tests__/pool-idle-connection-loss.test.ts` が縛っている）。加えて、`console.warn` で名乗る:

```
[@mnemora/postgres] pool の待機中の接続が失われた。捨てて続行する: terminating connection due to administrator command
```

名乗るだけで止めたい・自分で処理したい場合は、次のどちらかを選ぶ（**どちらも既定の警告は出さなくなる**）:

- **`onPoolError` を渡す**（渡した関数だけが呼ばれる）:

  ```ts
  const client = createPostgresClient(process.env.DATABASE_URL!, {
    onPoolError: (error) => {
      console.error("postgres pool error", error.message, (error as NodeJS.ErrnoException).code);
    },
  });
  ```

- **自分で `client.pool.on("error", …)` を付ける**（`onPoolError` を渡していない場合に効く。
  付ける順番は問わない——`createPostgresClient` の呼び出しより先でも後でもよい。判定は `error` が
  emit された時点で行うため）:

  ```ts
  const client = createPostgresClient(process.env.DATABASE_URL!);
  client.pool.on("error", (error) => {
    console.error("postgres pool error", error.message);
  });
  ```

- これは**待機中の接続**の話である。`db.transaction()` の途中（mnemora のストアが借りている最中の接続）で切れた場合は、
  `createPostgresClient` が drizzle に渡す包みがその接続に `error` リスナーを付けて外すので、プロセスは落ちず、その呼び出しが reject する
  （[Issue #868](https://github.com/takecchi/mnemora/issues/868)。`src/__tests__/db-transaction-connection-loss.test.ts` が縛っている）。
  公開する `client.pool` 自体には mnemora 既定のハンドラ以外を付けないので、利用者が `client.pool.connect()` で借りた接続には、利用者がリスナーを付けること。
- マイグレーションと `registerEmbeddingSpace` が借りる接続には、mnemora が自分でリスナーを付けている
  （[ADR 0339](../../docs/decisions/0339-checked-out-client-error-listener.md)。こちらは借りている最中の接続の話）。

### 2026-09-29 追記: 以前は「利用者が付ける」が今の振る舞いだった（Issue #1213）

**この節は、PR #1215（2026-09-27）の時点では「⚠ 接続の `error` リスナーは、利用者が付ける（今の振る舞い）」
という見出しで、`createPostgresClient` がリスナーを一切付けない・付けなければプロセスごと落ちる、という
振る舞いを固定していた。** 本 PR（Issue #1213）がその前提を反転させた——`createPostgresClient` は常に
リスナーを1つ付け、既定では警告して続行する。[ADR 0339](../../docs/decisions/0339-checked-out-client-error-listener.md)・
[ADR 0020](../../docs/decisions/0020-temp-database-drain-before-drop.md) が却下したのは**黙って捨てる形**
（空のリスナー）であり、本 PR の既定の振る舞いは**名乗る形**なので、その却下理由には当たらない
（詳細・区別・引き受けた負債は
[ADR 0356](../../docs/decisions/0356-pool-default-error-listener-warns-by-default.md)）。

## 例外の見分け方（catch するとき）

この package が投げる例外は、次の5つの顔に分かれる【実測 2026-09-27。「名前の無い `Error`」「DB に触れる前に断る `RangeError`」「DB が拒んだ例外」の3行は 2026-10-06・main `14de22b5` で測り直した】。

| 顔                               | 例                                                                                                                                                                                                                                                                                                                                                                            | 見分け方                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名前を持つ例外                   | 取り合いの衝突（`MemoryStatusConflictError`・`MemoryPurgeConflictError`・`ContestedWithoutCompanionError` は `@mnemora/core`）、lock 待ち（`AdvisoryLockTimeoutError`・`AdvisoryLockUnavailableError` と、その子の `MigrationLock*`・`RegisterEmbeddingSpaceLock*`）、`MissingExtensionsError`、`TrigramLexicalStoreUnavailableError`                                         | `instanceof`（どれも公開の class）。                                                                                                                                                                                                                                                                                                                                                              |
| `name` だけを持つ `Error`        | 埋め込み空間のテーブルの衝突（`registerEmbeddingSpace`。Issue #1151）                                                                                                                                                                                                                                                                                                         | `err.name === "EmbeddingSpaceTableConflictError"`（class は公開していない）。                                                                                                                                                                                                                                                                                                                     |
| 名前の無い `Error`               | 見つからない id・形の崩れた id・別テナントの id（どれも `memory not found for tenant`）、`TenantSettingsStore` の型の外の値（`setEventRetention` の `kind`・`days`）、NUL (U+0000) を含む `content` など（ADR 0499）、`OutboxStore.complete`/`fail` の `opts.at` が Invalid Date（ADR 0594）                                                                                  | 文面でしか分からない。**文面は約束しない。**                                                                                                                                                                                                                                                                                                                                                      |
| DB に触れる前に断る `RangeError` | `resolveContestedPair` の型の外の `status`（ADR 0499）、`OutboxStore.complete`/`fail` の `opts.at` が `timestamptz` の下限より前（ADR 0597）、ベクトルの成分が float4 に収まらない・`NaN`（ADR 0424）                                                                                                                                                                         | `err instanceof RangeError`。`cause` は無い。**文面は約束しない。**                                                                                                                                                                                                                                                                                                                               |
| DB が拒んだ例外                  | 負や整数でない `limit`、型の列挙に無い値（CHECK 制約。`createMemory` の `status`）、Invalid Date（`occurredAt`・`validFrom`・`reinforce` の `at`・`archiveDecayed` の `now`）、負や `NaN`、`1` を超える `strength`（CHECK 制約 `memories_strength_range`）、`timestamptz` の下限より前の日時（`occurredAt`・`reinforce` の `at`・イベントの `at`・`archiveDecayed` の `now`） | drizzle が包んだ `Error`（`err.name === "Error"`）。SQLSTATE は **`err.cause.code`** に在る（`err.code` には無い）。例: `23514`（CHECK 制約）・`2201W`（負の `LIMIT`）・`22P02`（形の崩れた値）・`22007`（Invalid Date）・`22008`（下限より前の日時）。負の `limit` は、行が1本も無いテナントの `purgeExpiredEvents` では投げずに返る（`listActiveClaimPredicates`・`archiveDecayed` は投げる）。 |

⚠ **`@mnemora/testkit/fixtures` は、DB が拒む入力を同じく拒むが、例外の顔は違う**（名前の無い
`Error` か、Postgres と同じ `RangeError`。`cause.code` は持たない）。⚠ `timestamptz` の下限より前の日時は、fixture も、行に日時を書く口（`archiveDecayed` の `now`、outbox の `opts.at`、`createMemory` の `occurredAt`・`reinforce` の `at`・イベントの `at` など）で `RangeError`（ADR 0500・0597・0640）で書き込みの前に断り、何も書かない（Postgres は `22008`。口と欄ごとの実測は ADR 0640）。下限ちょうどは、どちらも通る。読みの口の日時の条件は、どちらも断らない（ADR 0547）。揃えてあるのは「拒むかどうか」と「拒んだときに何も書かないこと」
だけである（`packages/testkit/src/fixtures.ts` の冒頭）。`cause.code` を見る処理のテストを fixture で
書くと、Postgres とは別の枝を通る。

### pool が枯れたとき・Postgres の再起動の最中に出る例外の形（ADR 0444）

**接続を借りる段階で失敗する例外と、文の実行中に失敗する例外とで、`code` の在り処が違う。**
**この版は形を揃えていない**（揃えるには例外の包み方を変える必要があり、公開の約束が動くため）。
**判定するなら、両方を見ること**: `err.code ?? err.cause?.code`。

【実測 2026-10-01、`pg_ctl stop`/`start`・`pg_terminate_backend`・`max: 1` の pool を借り切って確かめた】

| 形                                                                       | どこに `code` が在るか                                            | 出る場面（実測）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ① 包まれていない `pg` の例外                                             | **`err.code`**（`err.cause` は無い）                              | **`db.transaction()` が接続を借りる段階**の失敗: 止まっている間の `ECONNREFUSED`、起動の最中の `57P03`（`the database system is starting up`）。`client.pool.query()` を直接呼んだときも同じ形。                                                                                                                                                                                                                                                                                                                                                                                                       |
| ② drizzle が包んだ `DrizzleQueryError`（`message` は `Failed query: …`） | **`err.cause.code`**（`err.code` は無い）                         | **文を実行している最中**の失敗: 実行中に接続が切られた `57P01`（`terminating connection due to administrator command`）。`db.transaction()` の中の文の失敗もこの形。`db.transaction()` を使わない drizzle の呼び出し（`db.execute` など）が接続を借りる段階で失敗した `ECONNREFUSED`・`57P03` もこの形。                                                                                                                                                                                                                                                                                               |
| ③ `code` を持たない例外                                                  | **どこにも無い**。文面（`message`）でしか分からない（約束しない） | **pool の枯渇**: `timeout exceeded when trying to connect`（`connectionTimeoutMillis` を超えても、借りる順番が回ってこなかった）。**サーバーが応答しないときの接続タイムアウト**: `Connection terminated due to connection timeout`（TCP は繋がるが応答が無く、`connectionTimeoutMillis` を超えた。【実測】応答しない TCP サーバーに `max: 1`・`connectionTimeoutMillis: 300` で当てた。接続拒否〔`127.0.0.1:1`〕は `ECONNREFUSED` で、これは `code` を持つ）。`db.transaction()`・`client.pool.query()` では ① と同じく包まれず、`db.execute` では ② と同じく `DrizzleQueryError` の `cause` に入る。 |

- **どの呼び出しがどの形になるかは、公開の API からは読み取れない**（store の中で `db.transaction()` を使うか、`db.execute` を使うかで変わる）。
  `forget`・`purge` などの `outcomes[].error` は、`cause` の連鎖の各段の `message` と `code` を連結した文字列である
  （`code` は `(code: 57P01)` の形で載る）。
- **`rollback` が失敗したとき**（接続ごと切れたときに起きる）: 以前は `Failed query: rollback` が投げられ、元のエラー（上の `57P01` など）が消えていた。
  **いまは元のエラーが投げられる**（drizzle-orm 0.45.2 が `rollback` の失敗で元のエラーを捨てる不具合を、`createPostgresClient` が包んで直した。
  上流への報告はしていない。[ADR 0444](../../docs/decisions/0444-pool-begin-release-rollback-error-preserved.md)）。
  `rollback` の失敗は、元のエラーの **`cause`**（空いていれば）か **`rollbackError`**（drizzle が包んだ `DrizzleQueryError` は
  `cause` が埋まっているので、こちらになる）に残る。新しい例外の型は作っていない。
- **`observe` の抽出の候補ごとの savepoint（`rollback to savepoint`）が失敗したときも同じ**: 続けず、落とした候補にも積まず、**元のエラー**（`code` 付き）が投げられる。
  巻き戻しの失敗は元のエラーの `cause`（空いていれば）か `rollbackError` に残る（[ADR 0451](../../docs/decisions/0451-savepoint-rollback-failure-keeps-original-error.md)。上流への報告はしていない）。
- **`db.transaction()` の `begin` が失敗した接続は pool へ戻らず捨てられる**（以前は借りたまま戻らず、再起動を数回挟むと pool が枯れて
  すべての呼び出しが止まった。同上）。
- ③ が出たら、pool が枯れている（借りた接続が戻っていない）か、`max` が負荷に足りないかを疑うこと。
  `client.pool.totalCount - client.pool.idleCount` が、借りられたままの接続の数である。

## 運用: 語彙検索と `statement_timeout`

`PostgresLexicalStore`/`PostgresTrigramLexicalStore` は、検索クエリの語数・1語の文字数・
全体の文字数に上限を持ち、超えた分は先頭から切り詰める（`LEXICAL_QUERY_MAX_DISTINCT_WORDS`
= 32・`LEXICAL_QUERY_MAX_WORD_CHARS` = 64・`LEXICAL_QUERY_MAX_TOTAL_CHARS` = 600。この3つの名前は
内部の定数で、この package からは export していない——値は変えられず、import もできない。
[Issue #878](https://github.com/takecchi/mnemora/issues/878)・
[ADR 0092](../../docs/decisions/0092-lexical-or-coverage.md) 追記節）。
**この上限は、1回の検索にかかる時間を有界にするためのものであり、時間そのものの上限では
ない。**利用者の入力を検索クエリとして渡す場合は、DB 側でも `statement_timeout`
（ロール・データベース・接続のいずれかの単位）を設定して併用することを推奨する。

## 運用: 並列クエリ（`max_parallel_workers_per_gather`）は、件数集計を撃つ経路に効く

`recall()` の段5（`MemoryStore.aggregateScope` の `GROUP BY subject_id`）は、テナントの行数に比例して重くなる。
**並列クエリ（`max_parallel_workers_per_gather`）を 0 より大きくすると、この集計は速くなる**（Postgres 側の設定で、コードの変更は要らない）。
ただし、`recall()` の `scopeAggregate: "skip"` を渡す（`consolidate` / `reflect` の内部の recall は、これを渡す。
[ADR 0415](../../docs/decisions/0415-consolidate-reflect-skip-scope-aggregate.md)）と集計自体を撃たないので、並列の有無は効かない。

- 【実測】`consolidate({ target: { seedMemoryId } })` の p50（集計が走る経路。ADR 0415 より前の `main`）: 並列0 で 893 ms、
  `max_parallel_workers_per_gather=2` で 406 ms（約2.2倍）、4 で 269 ms（約3.3倍）。
- 測った条件: PostgreSQL 17.11、100万行・全件 active・単一テナント、`shared_buffers=2GB`、`max_worker_processes=16`、
  `max_parallel_workers=8`、32 vCPU の共有機（load average 23〜32）、単発の接続（同時1）。
- ⚠ **`/dev/shm` が小さい器（コンテナなど）では、並列クエリが動的共有メモリを確保できず失敗することがある。**
  その場合は `dynamic_shared_memory_type=mmap` を設定する。
- ⚠ **同時実行や他の負荷の下では測っていない。**並列ワーカーは `max_parallel_workers` を他のクエリと取り合うので、
  同時に走るクエリが多いと倍率は下がりうる（推論。測っていない）。

## ほかに export しているもの（約束は各 TSDoc）

上の例と節に出てこない公開の名前を、用途ごとに並べる（どれも `@mnemora/postgres` の入口から import できる）。

| 用途                                                                | 名前                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接続                                                                | `createPostgresClient`・`closePostgresClient`（2回目以降は冪等）・`PostgresClient`・`Db`                                                                                                                                                                                                                                                                                                                                                                                          |
| store                                                               | `PostgresEventStore`・`PostgresOutboxStore`・`PostgresTenantSettingsStore`（上の例で使う）、`PostgresTrigramLexicalStore` とその下ごしらえ（`probeTrigramLexicalSupport`・`ensureTrigramLexicalFunctions`・任意の索引 `createOptionalTrigramIndex`（並行版は `createOptionalTrigramIndexConcurrently`）、`TrigramLexicalStoreUnavailableError`・`TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`、`DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD`・`TRIGRAM_NOISE_STOPWORD_PATTERN`） |
| マイグレーション                                                    | `runMigrations`（`RunMigrationsOptions`・`RunMigrationsResult`・`ExtensionMode`）、`runAnalyzeMemories`、`listMigrationFiles`・`DEFAULT_MIGRATIONS_DIR`、`matchCreateExtensionLines`・`stripCreateExtensionStatements`                                                                                                                                                                                                                                                            |
| advisory lock                                                       | `acquireAdvisoryLock`・`releaseAdvisoryLock`、同じ接続の上で取る `acquireAdvisoryLockOnClient`・`releaseAdvisoryLockOnClient`、`DEFAULT_LOCK_TIMEOUT_MS`、キーの `MIGRATION_LOCK_KEY`・`REGISTER_EMBEDDING_SPACE_LOCK_KEY`・`EXTENSION_LOCK_KEY` と導出の `migrationLockKeyFor`・`registerEmbeddingSpaceLockKeyFor`、待ちの失敗の `*LockTimeoutError`・`*LockUnavailableError`                                                                                                    |
| 埋め込み空間                                                        | `registerEmbeddingSpace`（`RegisterEmbeddingSpaceOptions`・`RegisterEmbeddingSpaceResult`）、名前の導出 `embeddingSpaceTableName`・`embeddingSpaceIndexName`・`embeddingSpaceZeroNormIndexName`                                                                                                                                                                                                                                                                                   |
| スキーマ・識別子                                                    | `qualify`・`qualifiedLiteral`・`searchPathFor`・`DEFAULT_EXTENSION_SCHEMA`、`assertSafeSchemaName`・`assertSafeIdentifier`                                                                                                                                                                                                                                                                                                                                                        |
| 打つ SQL の組み立て（`EXPLAIN` の歯が本体と同じ文を見るためのもの） | `buildLexicalSearchSelect`・`buildTrigramLexicalSearchSelect`・`buildArchiveDecayedTargetSelect`・`buildRequeueEmbedTargetSelect`・`buildPurgeExpiredEventsTargetSelect`                                                                                                                                                                                                                                                                                                          |
| その他                                                              | `sha256Hex`（`contentHash` の実装）                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## もっと詳しく

- [docs/memory-model.md](../../docs/memory-model.md) §10 — DB schema・規約
- [docs/architecture.md](../../docs/architecture.md) §5 — 主要 interface
- [migrations/](./migrations) — 手書きの DDL（`drizzle-kit push` には頼らない。docs/memory-model.md §10「規約」・[ADR 0001](../../docs/decisions/0001-orm-drizzle.md)「ORM は Drizzle」）
- リポジトリ: https://github.com/takecchi/mnemora
