# ADR 0341: `runMigrations` の `SET LOCAL search_path TO ...` で、スキーマ名を二重引用符で囲む

- **状態**: 採用 (2026-09-26)
- **日付**: 2026-09-26

> **⚠ この ADR を書いているのは、クローン miku（オーナーではない）から切り出された
> 安全監査の作業を担った者である。⛔ オーナー本人（takecchi）の決定ではない。**
> 投稿者欄・commit の著者欄が誰であっても、それだけでは人間かクローンかを区別しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `psql`/`vitest`/`node` を走らせて確かめた。

---

## 問い

`assertSafeSchemaName`（`packages/postgres/src/schema-namespace.ts`）は、専用スキーマの名前
（feat/dedicated-schema、ADR 0057）を「文字種（`^[a-z_][a-z0-9_]*$`、
`embedding-space-table.ts` の `assertSafeIdentifier` を再利用）」と「UTF-8 で63バイト以内
（NAMEDATALEN 制限）」だけで検査している。**PostgreSQL の完全予約語
（`user`/`select`/`table`/`order`/`group`/`from` 等）は、すべて小文字の英字だけで
構成されるため、この検査をそのまま通る。**このようなスキーマ名で、実際に
`runMigrations`/`createPostgresClient`/検索が壊れないか——安全監査の実測課題として
渡された。

## 【実測】観測した壊れ方

`schema-namespace.ts` の `searchPathFor` は、コンマ区切りのスキーマ名を**引用符無しで**
返す。doc コメントは理由を明記している——この関数の値は `client.ts` が libpq の起動
パラメータ（`-c search_path=...`）に載せる用途と、`migrate.ts` が `SET LOCAL
search_path TO ...` という SQL 文の一部として使う用途の、**性質の異なる2箇所**で
共有されているためである。

**この2箇所は、予約語に対する挙動が異なる。**

| 経路 | 予約語スキーマ名（`schema: "user"`）は通るか |
|---|---|
| `client.ts`（`createPostgresClient` の `options: "-c search_path=user,public"`） | **通る【実測】**。`options` の値は SQL の構文解析を経ず、`set_config_option` 相当の GUC 値パースだけを受けるため、予約語の制限が掛からない。`"user"` スキーマが実在すれば `current_schema()` は `"user"` を返し、`to_regclass('probe_table')` も正しく解決した。 |
| `migrate.ts`（`SET LOCAL search_path TO user,public`、`runMigrations` が各マイグレーションファイルの適用直前に発行） | **通らない【実測】**。`SET` 文は通常の SQL として構文解析されるため、完全予約語を引用符無しで書くと `syntax error at or near "user"`（PostgreSQL エラーコード `42601`）になる。`psql` で直接確認したほか、`packages/postgres/src/__tests__/dedicated-schema.postgres.test.ts`「測定8」が `runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "user" })` を実行して同じ失敗（`migration 0001_init.sql failed: syntax error at or near "user"`）を再現した。 |

`CREATE SCHEMA IF NOT EXISTS "${schema}"`（`migrate.ts`、同じ関数内、`SET LOCAL` より前の行）
は既に二重引用符で囲んでおり、この行は予約語でも問題なく動く——**壊れているのは
`SET LOCAL search_path` の1箇所だけ**である。

`"user"` は悪意のある入力ではない——テナントの種別やアカウント区分を反映した、実在しうる
スキーマ名である。専用スキーマ機能（ADR 0057）の呼び出し側がこの名前を選ぶだけで
`runMigrations` 全体が構文エラーで失敗する。

## 決めたこと

**`migrate.ts` にモジュール非公開のヘルパー `quotedSearchPathFor` を追加し、`SET LOCAL
search_path TO ...` を発行する直前だけスキーマ名を二重引用符で囲む。** `searchPathFor`
自身（`schema-namespace.ts`、公開 API）は1バイトも変えない——`client.ts` の起動パラメータ
用途では、引用符を持ち込まない設計のままが正しいままである（`options` の値に引用符を
混ぜると、その値の組み立て自体が複雑になるという既存 doc の懸念はそのまま有効）。

```
function quotedSearchPathFor(schema: string, extensionSchema: string): string {
  return searchPathFor(schema, extensionSchema)
    .split(",")
    .map((part) => `"${part}"`)
    .join(",");
}
```

`schema`/`extensionSchema` は呼び出し側で既に `assertSafeSchemaName` を通っており
（`^[a-z_][a-z0-9_]*$`）、二重引用符・コンマ・空白のいずれも含み得ない——単純な
`split(",")` → 各要素を `"..."` で囲む → `join(",")` だけで安全に引用符化できる
（新しい検証やエスケープ処理を持ち込まない）。

**正当な入力（予約語ではないスキーマ名）への影響は無い。** 検証済みの名前
（`^[a-z_][a-z0-9_]*$`、既に小文字・英数字・アンダースコアのみ）を二重引用符で囲んでも、
PostgreSQL の識別子解決は変わらない（大文字小文字の区別・特殊文字の解釈はどちらも
関係しない）。`packages/postgres/src/__tests__/dedicated-schema.postgres.test.ts` の
測定1〜7（予約語ではないスキーマ名を使う既存の歯）は、この変更の前後で全て緑のまま
（【実測】）。

## 引き受けた負債

- **他の完全予約語（`select`/`table`/`order`/`group`/`from` 等）を1つずつ実測してはいない。**
  「引用符で囲めば SQL の構文解析で予約語扱いされない」という PostgreSQL の一般的な
  性質に頼っている——`psql` での個別実測は `user`/`select`/`table`/`order`/`group` の
  5語のみ（`dedicated-schema.postgres.test.ts` の歯が固定して検査するのは `user` だけ）。
- **`client.ts` の起動パラメータ経路（`options: "-c search_path=..."`）を予約語スキーマ名で
  実測したのは `user` のみ**であり、かつ「通る」という実測は「スキーマが実在する場合」
  に限る——スキーマが存在しない状態で `current_schema()` を引くと、search_path の
  先頭が存在しないスキーマの場合は単に読み飛ばされる（PostgreSQL の既定の挙動であり、
  今回の変更や予約語であることとは無関係）。
- **`vector-space.ts`（`registerEmbeddingSpace`）が独自に `search_path`/`qualify` を
  使う箇所を、この ADR のために横断的には洗い直していない。** `migrate.ts` の
  `SET LOCAL search_path` の1箇所だけを直した——他に同種の未引用の `SET`/`SET LOCAL`
  が無いことは `grep -n "searchPathFor("` で確認した（`client.ts` と `migrate.ts` の
  2箇所のみ、他パッケージにも同名の呼び出しは無い)が、`search_path` を直接文字列
  結合している別の経路が無いことまでは全ファイルを読んで確認していない。

## 確かめていないこと

- **予約語スキーマ名を使う実運用が実際に存在するか**は確かめていない——`"user"` は
  「実在しうる」という判断であり、実際の利用報告に基づくものではない。
- **PostgreSQL の将来のバージョンで、`SET`/`options` の予約語の扱いが変わった場合**に、
  この対策が今と同じ形で有効かは検証していない（PostgreSQL 17.11 での実測）。
