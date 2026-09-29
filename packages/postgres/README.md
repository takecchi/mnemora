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
  最後や、cron で定期的に呼んでも安全側に倒れる設計だが、**この副作用はこの
  リポジトリでは実測していない**（作業環境に Postgres が無いため）。詳細・
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
// （未登録の空間に PostgresVectorStore.upsert を呼ぶと "relation does not exist" で失敗する）。
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
```

上のコードを動かす前に、`mnemora-postgres-migrate` で該当 DB にスキーマを適用しておくこと。

⚠ この例には `ts check` の印を付けていない。`pnpm check:doc-snippets` はこの README の片を `packages/postgres` から解決し、このパッケージは `@mnemora/openai` に依存していないので、印を付けると `@mnemora/openai` が見つからずに落ちる。`examples/chat`（`@mnemora/openai` にも依存している）を起点にすれば型検査は通る（2026-09-28、main fd74b23 で確かめた）。⟹ **この例が今の公開 API で型検査に通ることを、CI は確かめていない。**

⚠ 2026-09-27 追記: 当時の見出しにあった「DB へは未実行」は、その時点の記録である。`pnpm pack` した tarball を repo の外の空のプロジェクトに入れ、`npx mnemora-postgres-migrate` の後に、この例の LLM・埋め込みだけを `@mnemora/testkit` の決定的な provider に差し替えて Postgres 17 + pgvector に対して走らせ、observe → tick → recall が通ることを確かめた。例そのまま（OpenAI）は鍵を要るので走らせていない——鍵が無いと `new OpenAIEmbeddingProvider(...)` の時点で OpenAI の SDK が `Missing credentials` で止まる。

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

### 索引（27）

- `idx_labels_by_status`
- `idx_memories_attributes`
- `idx_memories_by_subject`
- `idx_memories_claim_key`
- `idx_memories_contested`
- `idx_memories_contested_with`
- `idx_memories_digest_band`
- `idx_memories_lexical`
- `idx_memories_period_ann_stage`
- `idx_memories_provenance_kind`
- `idx_memories_recall_gate`
- `idx_memories_recall_gate_seq`
- `idx_memories_requeue_embed`
- `idx_memories_superseded_by`
- `idx_memories_tags`
- `idx_memory_events_by_kind`
- `idx_memory_events_by_memory`
- `idx_memory_events_by_retention`
- `idx_memory_labels_by_label`
- `idx_memory_relations_from`
- `idx_memory_relations_to`
- `idx_observations_by_subject`
- `idx_outbox_claimable`
- `idx_outbox_pending`
- `idx_recalls_by_subject`
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

### 実行時に増える系列（埋め込み空間ごと）

`registerEmbeddingSpace` を呼ぶたびに、その `EmbeddingSpaceId`
（`(provider, model, dimensions)`）ごとに次の名前が1組ずつ増える
（[`src/embedding-space-table.ts`](./src/embedding-space-table.ts)）:

- テーブル: `memory_embeddings_<space>`
- 索引（HNSW）: `idx_memory_embeddings_hnsw_<space>`
- 索引（ゼロベクトル用の部分索引、Issue #956 / ADR 0343）: `idx_memory_embeddings_zero_norm_<space>`

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

この package が投げる例外は、次の4つの顔に分かれる【実測 2026-09-27】。

| 顔 | 例 | 見分け方 |
|---|---|---|
| 名前を持つ例外 | 取り合いの衝突（`MemoryStatusConflictError`・`MemoryPurgeConflictError`・`ContestedWithoutCompanionError` は `@mnemora/core`）、lock 待ち（`AdvisoryLockTimeoutError`・`AdvisoryLockUnavailableError` と、その子の `MigrationLock*`・`RegisterEmbeddingSpaceLock*`）、`MissingExtensionsError`、`TrigramLexicalStoreUnavailableError` | `instanceof`（どれも公開の class）。 |
| `name` だけを持つ `Error` | 埋め込み空間のテーブルの衝突（`registerEmbeddingSpace`。Issue #1151） | `err.name === "EmbeddingSpaceTableConflictError"`（class は公開していない）。 |
| 名前の無い `Error` | 見つからない id・形の崩れた id・別テナントの id（どれも `memory not found for tenant`）、`TenantSettingsStore` の型の外の値 | 文面でしか分からない。**文面は約束しない。** |
| DB が拒んだ例外 | 負や整数でない `limit`、型の列挙に無い値（CHECK 制約）、Invalid Date、範囲外の `strength` | drizzle が包んだ `Error`（`err.name === "Error"`）。SQLSTATE は **`err.cause.code`** に在る（`err.code` には無い）。例: `23514`（CHECK 制約）・`2201W`（負の `LIMIT`）・`22P02`（形の崩れた値）・`22007`（日時）。 |

⚠ **`@mnemora/testkit/fixtures` は、DB が拒む入力を同じく拒むが、例外の顔は違う**（名前の無い
`Error`。`cause.code` を持たない）。揃えてあるのは「拒むかどうか」と「拒んだときに何も書かないこと」
だけである（`packages/testkit/src/fixtures.ts` の冒頭）。`cause.code` を見る処理のテストを fixture で
書くと、Postgres とは別の枝を通る。

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

## ほかに export しているもの（約束は各 TSDoc）

上の例と節に出てこない公開の名前を、用途ごとに並べる（どれも `@mnemora/postgres` の入口から import できる）。

| 用途 | 名前 |
|---|---|
| 接続 | `createPostgresClient`・`closePostgresClient`（2回目以降は冪等）・`PostgresClient`・`Db` |
| store | `PostgresEventStore`・`PostgresOutboxStore`・`PostgresTenantSettingsStore`（上の例で使う）、`PostgresTrigramLexicalStore` とその下ごしらえ（`probeTrigramLexicalSupport`・`ensureTrigramLexicalFunctions`・任意の索引 `createOptionalTrigramIndex`、`TrigramLexicalStoreUnavailableError`・`TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`、`DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD`・`TRIGRAM_NOISE_STOPWORD_PATTERN`） |
| マイグレーション | `runMigrations`（`RunMigrationsOptions`・`RunMigrationsResult`・`ExtensionMode`）、`runAnalyzeMemories`、`listMigrationFiles`・`DEFAULT_MIGRATIONS_DIR`、`matchCreateExtensionLines`・`stripCreateExtensionStatements` |
| advisory lock | `acquireAdvisoryLock`・`releaseAdvisoryLock`、同じ接続の上で取る `acquireAdvisoryLockOnClient`・`releaseAdvisoryLockOnClient`、`DEFAULT_LOCK_TIMEOUT_MS`、キーの `MIGRATION_LOCK_KEY`・`REGISTER_EMBEDDING_SPACE_LOCK_KEY`・`EXTENSION_LOCK_KEY` と導出の `migrationLockKeyFor`・`registerEmbeddingSpaceLockKeyFor`、待ちの失敗の `*LockTimeoutError`・`*LockUnavailableError` |
| 埋め込み空間 | `registerEmbeddingSpace`（`RegisterEmbeddingSpaceOptions`・`RegisterEmbeddingSpaceResult`）、名前の導出 `embeddingSpaceTableName`・`embeddingSpaceIndexName`・`embeddingSpaceZeroNormIndexName` |
| スキーマ・識別子 | `qualify`・`qualifiedLiteral`・`searchPathFor`・`DEFAULT_EXTENSION_SCHEMA`、`assertSafeSchemaName`・`assertSafeIdentifier` |
| 打つ SQL の組み立て（`EXPLAIN` の歯が本体と同じ文を見るためのもの） | `buildLexicalSearchSelect`・`buildTrigramLexicalSearchSelect`・`buildArchiveDecayedTargetSelect`・`buildRequeueEmbedTargetSelect`・`buildPurgeExpiredEventsTargetSelect` |
| その他 | `sha256Hex`（`contentHash` の実装） |

## もっと詳しく

- [docs/memory-model.md](../../docs/memory-model.md) §10 — DB schema・規約
- [docs/architecture.md](../../docs/architecture.md) §5 — 主要 interface
- [migrations/](./migrations) — 手書きの DDL（`drizzle-kit push` には頼らない。docs/memory-model.md §10「規約」・[ADR 0001](../../docs/decisions/0001-orm-drizzle.md)「ORM は Drizzle」）
- リポジトリ: https://github.com/takecchi/mnemora
