# ADR 0366: `probeTrigramLexicalSupport` は `pg_trgm` を、`vector` が入っているスキーマへ合わせる（引数は増やさない。Issue #1256）

- **状態**: 採用 (2026-09-29)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから委譲された、
> クローン miku の委譲先）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)の
> 同種の注記と同じ——repo 上の署名だけではオーナー本人と区別が付かない。
> **この決定を担い手が自分で下してよい根拠は
> [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)** である。
> Issue #1256 本文が挙げた3案のうち、この ADR は「1. 拡張のスキーマを渡す口を足す」の
> **変種**（口は足さず、`vector` の実際のスキーマを読んで合わせる）と「2. 新しい理由で
> 名乗る」を採る。方向そのものの変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0253・0358・0361 の体裁を踏む）。

- **【現物】** — この repo のコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で PostgreSQL 17 + pgvector を走らせて確かめた。
- **推測** — 出所を明示していない考察・見立て。

---

## 文脈

[Issue #1256](https://github.com/takecchi/mnemora/issues/1256) が名指しした問題【現物・要約】:

`runMigrations` は、必須の拡張（`vector`・`btree_gin`・`pgcrypto`）を
`CREATE EXTENSION IF NOT EXISTS <ext> WITH SCHEMA "<extensionSchema>"` で入れる
（既定 `public`。専用スキーマの構成、#757）。一方 `probeTrigramLexicalSupport`
（`PostgresTrigramLexicalStore.create` が内部で呼ぶ）は、`CREATE EXTENSION IF NOT EXISTS
pg_trgm` を **`SCHEMA` を指定せずに**発行していた。拡張は `search_path` の先頭、つまり
接続の名前空間のスキーマに入る。

⟹ 1つの DB に複数の名前空間を置く構成（#757 の目的）では、trigram の語彙照合を opt-in
できるのは、最初に probe した名前空間だけになる。2つ目以降は、`word_similarity` が
見えない DB の素の例外（`42883`）で落ちていた——`TrigramLexicalStoreUnavailableError`
ではなく、呼び出し側が分類できない例外だった。

Issue 本文は「判断が要る」として3案を挙げ、直し方を決めずに止めていた:

1. `probeTrigramLexicalSupport`・`PostgresTrigramLexicalStore.create` に拡張のスキーマを
   渡す口を足し、`WITH SCHEMA` で入れる（引数が増える）。
2. 自己一致の検査の失敗を捕まえ、新しい理由で名乗る（`TrigramLexicalProbeResult` の union
   に値が増える）。
3. このままにし、今の振る舞いを doc に書く（実際に `trigram-probe-dedicated-schema.postgres.test.ts`
   として別 PR で先に着地した——このファイルの「2026-09-28 追記」の歯）。

---

## 測ったこと【実測 2026-09-29】

自分専用の PostgreSQL 17 + pgvector（`server_encoding=UTF8`）で確認した。

1. `createPostgresClient({schema, extensionSchema})` は接続の `search_path` を
   `<schema>,<extensionSchema>` にする。`pg_trgm` を `extensionSchema` に入れれば、SQL を
   修飾しなくても両方の名前空間から `word_similarity`・`%>`・`gin_trgm_ops` が見え、
   probe/create/search が通る。
2. 既に `ns_a` に入った DB で `ALTER EXTENSION pg_trgm SET SCHEMA public` を流すと通る。
   GIN 索引は有効なまま残り、`ns_a` も `ns_b` も動く。
3. `DROP SCHEMA ns_a CASCADE` を流すと、`pg_trgm` がまだ `ns_a` の中にあれば、拡張ごと消える
   （拡張がそのスキーマ内の依存物として扱われるため）。
4. `SELECT n.nspname, n.nspname = ANY(current_schemas(true)) FROM pg_extension e JOIN
   pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'` で、拡張の実際の
   スキーマと、それが今の接続から見えるかどうかを判定できる。

---

## 決定

### 決定1. 明示の上書き口は足さない。`vector` 拡張が入っているスキーマを実行時に読み、
そこへ `pg_trgm` を `WITH SCHEMA` で合わせる

`probeTrigramLexicalSupportWithCause`（`trigram-lexical-store.ts`）は、`CREATE EXTENSION`
の直前に `pg_extension`/`pg_namespace` を読んで `vector` 拡張のスキーマと
`current_schema()` を1回のクエリで取る。

- `vector` が見つからない、またはそのスキーマが `current_schema()` と同じ
  （`schema` を渡さない既定の構成で、`vector` が `search_path` の先頭のスキーマに在る場合）
  ときは、**発行する SQL 文字列を 1バイトも変えない**（`CREATE EXTENSION IF NOT EXISTS pg_trgm`、
  `SCHEMA` を指定しない）。`trigram-probe-dedicated-schema.postgres.test.ts`「(d) 既定の構成」の
  歯が、実際に発行された SQL 文字列を記録して縛っている。
- そうでなければ（専用スキーマの構成で `vector` が `extensionSchema` に入っている場合。**⚠ 既定の
  構成でも、利用者が `vector` を先頭以外のスキーマ——拡張専用のスキーマなど——に置いている場合を
  含む**。そのとき `pg_trgm` は、今までは先頭のスキーマに入っていたが、以後は `vector` と同じ
  スキーマに入る。同歯「(e)」が縛る）、`sql.identifier`（二重引用符で囲み、中の `"` を `""`
  にする）で識別子として埋め込む。**`assertSafeSchemaName` では検証しない**——カタログから
  読んだ名前は mnemora が検証して作った名前とは限らず（上の既定の構成の場合）、弾くと今まで
  通っていた構成が `extension_create_failed` で落ちるようになるため（同歯「(e)」は大文字・
  記号・`"` を含むスキーマ名で縛っている）。

**なぜ引数を足さないか（Issue 本文の案1を「そのままは」採らない理由）**: `vector` の
スキーマは `runMigrations` が既に決めている——専用スキーマの構成では常に
`extensionSchema` に、既定の構成では `current_schema()` に入る。**`probeTrigramLexicalSupport`
に渡す新しい引数を足すと、呼び出し側が「`runMigrations` に渡したのと同じ値」を、
別の場所でもう一度正しく持ち回る責務を負う。** 値が2箇所で食い違えば
（`runMigrations` には `extensionSchema: "a"`、`probeTrigramLexicalSupport` 呼び出し側は
何も渡さない、など）、今回直そうとしている「静かな失敗」が形を変えて残る。**`vector` の
実際の置き場所を読みに行けば、真実は常に1箇所（`pg_extension`）にしかない。**

### 決定2. 既に別のスキーマへ入ってしまった `pg_trgm` は、自動では移さない

`CREATE EXTENSION IF NOT EXISTS` を使う以上、既に存在する `pg_trgm` には触れない
（Postgres の仕様どおり、拡張は DB 全体に1つしか置けない——`pg_extension_name_index` は
`extname` 単独）。作成後に「この接続の `search_path` から見えるか」を確認し（測ったこと4）、
見えなければ新しい理由 `"extension_not_visible"` で `{ ok: false, reason, detail }` を
返す（`detail` は拡張が実際に入っているスキーマ名）。`create()` はこれを
`TrigramLexicalStoreUnavailableError` にして投げる——素の `42883` はもう出ない。

**なぜ自動で `ALTER EXTENSION ... SET SCHEMA` しないか**:

- `ALTER EXTENSION` には、拡張の所有者相当の権限が要る。`probeTrigramLexicalSupport` は
  読み取り中心の検査関数であり、ここで昇格した権限操作を暗黙に行うと、権限を持たない
  ロールで呼んだときの失敗の形が変わってしまう（今の `extension_create_denied` と同じ
  分類の失敗を、別の operation で作ることになる）。
- 移動は、他の名前空間（今回の例では `ns_a`）が **既に `pg_trgm` に依存して動いている
  可能性**を考慮せずには行えない——移す前にそちらの動作を止めてよいかは、呼び出し側
  （運用者）が判断することであり、ライブラリが黙って行うことではない。
- 直し方（`ALTER EXTENSION pg_trgm SET SCHEMA <extensionSchema>`）は単純な1文であり、
  権限を持つロールで一度実行すれば全ての名前空間から見えるようになる——自動化の複雑さに
  見合う頻度の操作ではない（専用スキーマの構成へ移行する初回、または今回のバグを踏んだ
  既存 DB を直すときの、一度きりの運用作業）。

### 決定3. 解決は `search_path` に任せる。関数・演算子の修飾はしない

`buildTrigramLexicalSearchSelect` などの検索クエリ側は変更していない——`word_similarity`・
`%>` 演算子の呼び出しは今までどおり裸の名前のままで、`search_path`（`<schema>,<extensionSchema>`）
が解決する。今回の変更は「`pg_trgm` をどこに `CREATE EXTENSION` するか」だけであり、
インストール後の呼び出し経路には触れていない。

---

## 既存 DB への影響と直し方

- **新しく作る DB**: 影響は無い方向にしか変わらない——専用スキーマの構成で、どの名前空間
  から `probeTrigramLexicalSupport`/`PostgresTrigramLexicalStore.create` を呼んでも、
  `pg_trgm` は `extensionSchema`（既定 `public`）に入り、全ての名前空間から見える。
- **既に `pg_trgm` が `extensionSchema` に入っている DB**（共有スキーマの構成、または
  たまたま最初に probe した名前空間が `extensionSchema` と一致していた DB）: 影響は無い。
- **このバグが直る前に作られ、`extensionSchema` 以外の名前空間へ `pg_trgm` が入って
  しまった DB**: 影響がある。その名前空間自身は今までどおり `{ ok: true }` のままだが、
  **2つ目以降の名前空間は、今まで素の `42883` で落ちていたのが、`{ ok: false, reason:
  "extension_not_visible", detail: "<拡張が実際に入っているスキーマ名>" }`（`create()` は
  `TrigramLexicalStoreUnavailableError`）に変わる**——落ちること自体は変わらないが、
  分類できる形になる。
  - 直すには、拡張の権限を持つロールで
    `ALTER EXTENSION pg_trgm SET SCHEMA <extensionSchema>` を実行する。
  - **⚠ 注意**: `pg_trgm` をその名前空間に入れたまま `DROP SCHEMA <schema> CASCADE` を
    実行すると、拡張ごと消える（測ったこと3）。専用スキーマを片付ける前に、まず
    `pg_trgm` の置き場所を確認すること。

---

## 採らなかった案

### Issue 本文の案1をそのまま（`probeTrigramLexicalSupport`/`create` に `extensionSchema`
引数を追加し、呼び出し側に明示させる）

**却下の理由**: 決定1に書いたとおり、値の二重管理を呼び出し側に強いる。`runMigrations`
の呼び出しと `PostgresTrigramLexicalStore.create` の呼び出しが同じ `db`（＝同じ接続・
同じ `search_path`）を共有している以上、`vector` の実際の置き場所を読みに行くほうが、
真実の在り処が1箇所で済む。

### 何もしない（Issue 本文の案3をそのまま。doc だけで振る舞いは変えない）

**却下の理由**: 素の `42883` を投げ続けることは、このストア全体の設計原則
（このファイル冒頭の doc「静かな0件を潰す」・`TrigramLexicalProbeResult` の doc）と
真正面から矛盾する——「なぜ使えないか」を呼び出し側が分類して扱えるようにするための
関数が、2つ目の名前空間でだけ分類不能な例外を投げるのは、その関数自身の存在理由を
裏切っている。

---

## 引き受けた負債

1. **`ALTER EXTENSION ... SET SCHEMA` を自動化していない**——決定2に書いたとおり、
   既存の壊れた DB を直すのは運用者の一度きりの作業として残る。
2. **`vector` が `extensionSchema` ではない場所に在る構成**（利用者が独自に `vector` を
   別のスキーマへ置いた・移した、など）では、`pg_trgm` もそこへ入る——「`vector` と同じ
   場所」という規則をそのまま当てるだけで、特別扱いはしない。そのスキーマが `search_path`
   に無ければ、手順4が `extension_not_visible` で名乗る（`vector` 自体も見えないはずなので、
   その構成では mnemora の他の部分も先に落ちる）。
3. **`vector` が `pg_extension` に無いとき**（`runMigrations` を通さずに probe だけを呼んだ、など）
   は今までと同じ `SCHEMA` 無しの `CREATE EXTENSION` に倒す。そのときの置き場所は
   `search_path` の先頭であり、この ADR の直しは効かない。

## これが覆るとしたら何が起きたときか

- 複数の名前空間間で拡張の置き場所を移動する運用が頻繁になった場合⟹ 決定2を見直し、
  `ALTER EXTENSION` を伴う明示的な「移行」用の別関数を用意することを検討する。
- `vector` 以外の拡張（`extensionSchema` の決め方の基準そのもの）が変わった場合⟹
  `probeTrigramLexicalSupport` が参照する拡張名も合わせて見直す。

---

## 測ったこと・確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

上の「測ったこと」節のとおり——`extensionSchema` へ合わせて `pg_trgm` を入れる経路、
`ALTER EXTENSION ... SET SCHEMA` による復旧、`DROP SCHEMA ... CASCADE` で拡張ごと消える
こと、可視性判定の SQL を、すべて手元の PostgreSQL 17 + pgvector で実際に確かめた。

**歯**: `packages/postgres/src/__tests__/trigram-probe-dedicated-schema.postgres.test.ts`
（新しく作る DB・カスタムな `extensionSchema`・既存の壊れた DB・`ALTER EXTENSION` での
復旧・既定構成での SQL 文字列不変、の5ケース）。

### 確かめていないこと

- `vector` 拡張自体が存在しない構成（`REQUIRED_EXTENSIONS` を経由しない独自のマイグレー
  ション運用）での挙動——理論上は「今までどおり」になるはずだが、実測はしていない。
- 大規模な既存 DB で `ALTER EXTENSION ... SET SCHEMA` を実行したときの所要時間・ロックの
  実測（カタログの更新のみで、依存する索引の再構築は伴わないはずだが、実測はしていない）。
