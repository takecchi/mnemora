# ADR 0331: 拡張を作る段だけを、schema に依らない共有 advisory lock で直列化する

- **状態**: 採用 (2026-09)

> **⚠ この ADR はクローン（miku）の委譲で動くセッションが書いた。オーナー本人ではない
> （ADR 0220）。**直し方そのもの（挙動を変える形——拡張を作る段だけ schema に依らず
> 共有キーで直列化する。内部リトライは採らない。既定値は変えない）はオーナーの判断として
> 別途下りている。ここに書くのはその実装・実測・引き受けた負債の記録である。

- **文脈**:

  [Issue #757](https://github.com/takecchi/mnemora/issues/757) が実測した壊れ方:
  schema の違う `runMigrations()`（ADR 0057「専用スキーマ」）を、まっさらな DB へ
  同時に流すと、`CREATE EXTENSION IF NOT EXISTS` 同士が
  `23505 duplicate key value violates unique constraint "pg_extension_name_index"`
  で衝突し、決定的にどちらかが落ちる。

  原因は2つの事実の組み合わせである:

  1. `pg_extension` の一意制約 `pg_extension_name_index` は **`extname` 単独**に
     張られている——拡張は `search_path`/`schema` に関わらず**データベース全体に1つ**
     しか置けない（ADR 0057 の測定表が既に記録していた性質）。
  2. `migrationLockKeyFor`（ADR 0057 決定6）は `schema` ごとに**別の** advisory lock
     キーを返す——2つの mnemora が同じ DB の別スキーマに同居しても互いを
     ブロックしないようにするための、意図した設計である。

  この2つが噛み合うと、「schema の違う `runMigrations` は互いに待たない」×「拡張は
  DB 全体で1つしか作れない」で、**必ず衝突しうる窓**が生まれる。Issue #757 の実測
  （本物の PostgreSQL 17.11 + pgvector、`child_process.spawn` + IPC バリアで別プロセスを
  揃え、試行ごとにまっさらな DB を作った）:

  | 設定                                | 試行 | 失敗した試行 |
  | ----------------------------------- | ---- | ------------ |
  | 指定 s1 ＋ 指定 s2                  | 25   | **25**       |
  | 未指定 ＋ 指定 s1                   | 25   | **25**       |
  | `extensionSchema` も s1/s2 に分けた | 20   | **20**       |

  **`extensionSchema` を分けても防げない**——拡張の一意性はスキーマではなく DB 全体に
  掛かるため。

- **測ったこと（本物の PostgreSQL 17.17 + pgvector 0.8、手元の `initdb` インスタンス）**:

  修正前の `main`（Issue #757 が実測した sha の後継、`9bc62c9` 時点）に対して、
  `packages/postgres/src/__tests__/migrate-extension-lock-race.test.ts`（本 PR で新設）を
  当てた。`migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` が既に
  このリポジトリで使っている方式（同一プロセス内、`Pool` を分けて `Promise.all` /
  `Promise.allSettled` で本当に並行にクエリを送る——advisory lock はセッション単位の
  名前空間なので、OS プロセスを分けなくても DB 側では真に並行なセッション競合になる）
  に倣い、試行ごとに `createBlankDatabase` でまっさらな DB を作って捨てた（CI 時間を
  抑えるため、Issue #757 の25試行ではなく、各組8試行——ADR 0018 追記（Issue #755）が
  使った N=8 に合わせた）。

  | 組                 | 試行 | 修正前（失敗）                       | 修正後（失敗） |
  | ------------------ | ---- | ------------------------------------ | -------------- |
  | 未指定 ＋ 指定 s1  | 8    | **8/8**（`pg_extension_name_index`） | 0/8            |
  | 指定 s1 ＋ 指定 s2 | 8    | **8/8**（`pg_extension_name_index`） | 0/8            |

  修正前の失敗は全件 `23505 duplicate key value violates unique constraint
"pg_extension_name_index"`（未指定側が負けると `migration 0001_init.sql failed: ...`
  として現れる）——Issue #757 の実測と一致する。

  **変異試験**（`cp` で退避・復元。`git checkout` は使わない）:

  - 変異1: `schema` を指定した経路の共有ロック（`CREATE EXTENSION ... WITH SCHEMA`
    ループの前後）だけを外す → 「未指定＋指定s1」「指定s1＋指定s2」の**両方**が
    8/8 失敗に戻った。復元後、両方とも 0/8 に戻ることを確認した。
  - 変異2: `schema` 未指定の経路の共有ロック（未適用ファイルが `CREATE EXTENSION` 行を
    含むときだけ取る側）だけを外す → 「未指定＋指定s1」だけが 8/8 失敗に戻り、
    「指定s1＋指定s2」は 0/8 のまま（両方とも `schema` を指定しているため、
    この変異の影響を受けない）。**この非対称な結果が、2本の歯がそれぞれ別の
    コードパスを踏んでいることの証拠になる。**復元後、両方とも 0/8 に戻ることを
    確認した。

  既存の並行テスト一式（`migrate-concurrency.test.ts` / `migrate-ledger-handover.test.ts` /
  `migrate-partial-apply.test.ts` / `migrate.test.ts` / `migrate-default-path-unchanged.test.ts` /
  `migrate-cli-schema.postgres.test.ts` / `migrate-cli-process.test.ts` /
  `vector-space-concurrency.test.ts` / `extension-mode.test.ts` / `schema-namespace.test.ts`、
  計11ファイル・70本）も、修正後の状態ですべて緑であることを確認した
  （PR 本文に実測出力を残す）。

  🔴 **最初の実装は接続を1本余計に借りていて、`max: 2` の pool でデッドロックした。**
  `EXTENSION_LOCK_KEY` の取得に、schema ロックとは別に `pool.connect()` した新しい接続を
  使う実装を最初に書いたところ、`runMigrations` が同時に必要とする接続数が2本
  （schema ロック用の1本 + 個々のクエリ用の1本）から3本に増え、`migrate-concurrency.test.ts` /
  `migrate-ledger-handover.test.ts` の既存テスト（`max: 2` の `Pool` を明示的に使っている）が
  ことごとくタイムアウトした（**hook timeout 30000ms**、`まっさらな DB へ4プロセス相当が
同時に migrate しても` 等）。3本目の `pool.connect()` が、他の2接続が使用中のまま
  永遠に解決しない、という自己誘発のデッドロックだった。**同一セッションが複数の
  異なるキーの advisory lock を同時に保持できる**（PostgreSQL の仕様）ことを使い、
  schema ロックを保持している同じコネクション（`lockClient`）の上で
  `pg_advisory_lock`/`pg_advisory_unlock` をもう1回撃つ形に直したところ、接続数は
  今日と同じ2本のままで解決した。**この実測が、下の「採らなかった案」の1つになっている。**

- **決定**:

  1. **`EXTENSION_LOCK_KEY`**（`packages/postgres/src/migrate.ts`）という、`schema` に
     依らない**固定の共有** advisory lock キーを新設した。導出は `MIGRATION_LOCK_KEY` /
     `REGISTER_EMBEDDING_SPACE_LOCK_KEY` と同じ手順（固定文字列
     `"mnemora:runMigrations:extension-lock"` の SHA-256 先頭8バイトを符号付き64bit整数
     として解釈）。既存2定数と衝突しない値であることを確認済み。
  2. **schema ごとのロック（`migrationLockKeyFor`）はそのまま残す。**新しいキーは
     それに*追加で*取る2本目のロックであり、置き換えではない。
  3. **取得順は常に「schema ごとのロック → 共有の拡張ロック」に固定する。**逆順で
     取る経路は作らない（デッドロック回避のため、意図的に一方向にした）。
  4. **`extensionMode: "create"`（既定）のときだけ使う。**`"verify"`（ADR 0093）は
     `CREATE EXTENSION` を一切発行しないので、この共有ロックも一切参照しない。
  5. `schema` を指定した経路は、既存の `CREATE EXTENSION ... WITH SCHEMA` ループの
     前後だけ共有ロックを保持する（ループはオートコミットの単発クエリの並びなので、
     ループの前後で取得・解放すれば足りる）。
  6. `schema` 未指定の経路は、拡張が `migrations/0001_init.sql` の本文
     （トランザクション内）で作られるため、**未適用のファイルのうち、既存の抽出規則
     （`CREATE_EXTENSION_LINE_PATTERN` / `matchCreateExtensionLines`、ADR 0093 で
     `extensionMode: "verify"` 用に既に切り出してあったもの）に一致する行を含むものを
     適用する間だけ**、トランザクション開始前から `COMMIT` の直後まで共有ロックを保持する。
     **未適用のファイルに該当するものが無ければ（2回目以降の定常状態）、この共有ロックは
     一切取得されない**——`runMigrations` が定常状態で発行する SQL は今日と1文字も
     変わらない。
  7. **エラーの語彙は新設しない。**共有ロックの取得が時間切れ／取得不能になったときも、
     既存の `MigrationLockTimeoutError` / `MigrationLockUnavailableError`
     （`lockTimeoutMs` を schema ロックと共用）をそのまま投げる。呼び出し側から見て
     「`runMigrations` の advisory lock が時間切れ／取得不能だった」という観測できる
     事実は、どちらのロックで起きたかに関わらず同じであり、対処（待って再試行する／
     権限を見直す）も変わらないため。
  8. `options.lockKey`（テスト用の上書き口）は**schema ごとのロックだけに効く**。
     共有の拡張ロックは常に固定の `EXTENSION_LOCK_KEY` を使い、上書きの対象にしない
     ——共有ロックの目的が「schema を跨いで全員が同じキーを見ること」自体である以上、
     呼び出しごとに差し替えられては直列化そのものが崩れる。

- **採らなかった案**:

  - **`EXTENSION_LOCK_KEY` 用に新しい接続を pool から借りる。**最初に実装した形。
    `runMigrations` が同時に要求する接続数が2本から3本に増え、`max: 2` で書かれた
    既存の並行テストが接続を使い切ってデッドロックすることを実測した（上の測定節）。
    **同一セッションで複数の advisory lock を保持する形に直し、接続数を今日と同じ
    2本に保った。**
  - **内部でリトライする（`23505` を捕まえて再試行する）。**オーナーの判断で明示的に
    退けられている（依頼文「内部リトライは採らない」）。加えて、`0001_init.sql` は
    「まっさらな DB へ素の `search_path` 任せで流す」経路の一部として拡張の
    `CREATE EXTENSION` を含んでおり、リトライは「そのトランザクション全体を
    もう一度やり直す」ことを意味する——ロールバック済みの状態から再実行できることは
    保証されているが（`runMigrations` は元々冪等な設計）、**衝突そのものを
    構造的に防ぐ**（このロックの狙い）ことと、**衝突したら拾って直す**ことは
    別の設計であり、後者は「拾い損ねる」経路を常に持つ。
  - **schema ごとのロックを、拡張の生成にも常に共有キーへ統合する（schema ロックを
    廃止して常に単一キーにする）。**ADR 0057 決定6が「2つの mnemora が同じ DB の
    別スキーマに同居すると、片方の migrate がもう片方を黙ってブロックする」ことを
    避けるために schema ごとのキーを選んだ理由がそのまま生きている——**マイグレーション
    全体**を単一キーに戻すと、無関係な schema 同士が全面的に直列化されてしまう。
    **拡張を作る段だけ**を共有にすることで、この決定2は保ったまま、`CREATE EXTENSION`
    という DB 全体に効く操作のところだけを直列化する。
  - **`extensionSchema` を schema ごとに分ける。**Issue #757 が既に実測して否定している
    ——拡張の一意性は `extname` 単独であり、スキーマの分離では防げない。
  - **`CREATE EXTENSION` に `IF NOT EXISTS` 以上の対策（`ON CONFLICT` 相当）を積む。**
    PostgreSQL の `CREATE EXTENSION` に競合時動作を選べる構文は無い。ADR 0017/0018 が
    `CREATE TABLE`/`CREATE INDEX` で見た「個々の DDL に対策を積んでも、症状が別の層へ
    移るだけ」という結論と同じ形であり、入り口をロックで塞ぐ方針を踏襲した。

- **引き受ける負債**:

  - **決定2（ADR 0057、「`schema` を指定しない既定の経路は、発行される SQL が今日と
    同一である」）に、小さいが正直な逸脱がある。** `schema` 未指定の経路でも、
    **初回**（未適用のファイルに `CREATE EXTENSION` 行を含むものがある間）だけ、
    ロック用の接続（schema ロックを保持している `lockClient`）に対して
    `pg_advisory_lock`/`pg_advisory_unlock` の呼び出しが2回増える。**DDL・DML の
    発行内容は1文字も変わらない**——増えるのは advisory lock の制御用クエリのみで、
    かつ2回目以降の呼び出し（定常状態）では一切増えない。ADR 0057 決定2が守ろうとした
    実質（「既に mnemora を使っている環境は、この変更で1ミリも動かない」）は保たれている
    と判断するが、文字通りの「1バイトも変わらない」は初回適用時に限り成立しない。
  - **🟠 ロール名とスキーマ名が同じだと、`schema` 未指定の接続が意図せず専用スキーマを
    読み書きする問題は、この ADR では直さない。** Issue #757 のコメントが実測した
    別の壊れ方（既定の `search_path` が `"$user", public` であるため、ロール名と同じ
    スキーマが存在すると `schema` 未指定の接続がそちらへ黙って書き込む。ロックキーも
    「未指定なら既定の定数」に倒れるため、明示指定の側とキーが食い違う）は、
    **本 ADR が対象にした「拡張の DB 全体一意性」とは別の性質の問題**であり
    （こちらは「衝突して落ちる」ではなく「例外を出さずに違う場所を読み書きする」）、
    同じ直し方（共有ロック）では塞げない。別 Issue
    （[#779](https://github.com/takecchi/mnemora/issues/779)）に切り出した。
  - **拡張の共有ロックは、`REQUIRED_EXTENSIONS` の3本すべてを1本のロックで一括して
    守る（拡張ごとに別キーにしない）。**ADR 0018 が `registerEmbeddingSpace` について
    「埋め込み空間ごとにキーを分けない」と決めた理由と同じ形——拡張はどれも同じ
    `pg_extension_name_index` を共有する以上、分ける実益が無い。

- **これが覆るとしたら**:

  - **`CREATE EXTENSION` に、PostgreSQL 側でアトミックな「既に在れば何もしない」保証が
    追加されたとき。**（`IF NOT EXISTS` は構文上あるが、並行実行時の非アトミック性は
    ADR 0017/0018/Issue #757 が繰り返し実測している——これは PostgreSQL 側の性質であり、
    mnemora 側の実装では変えられない。）
  - **`schema` を指定した接続と指定しない接続を同じ DB に混ぜる運用そのものを
    やめると決めたとき。**ADR 0057「確かめていないこと」が最初から留保していた組み合わせ
    であり、もし「同居させない」という運用制約に倒すなら、この共有ロックの必要性
    そのものが消える。

- **確かめたこと / 確かめていないこと**:

  - **確かめた**: 上の測定節（修正前 8/8 失敗・修正後 0/8、2本の変異試験、既存並行
    テスト11ファイル70本の回帰無し）。
  - **確かめていない**: Issue #757 が確かめていないとした項目（5本以上同時の拡張の
    競合・CI の service container での再現・2回目以降の適用が並行した場合の実測——
    こちらは推論のまま）は、本 PR でも確かめていない。
  - **確かめていない**: 🟠（ロール名＝スキーマ名）の直し方。別 Issue に切り出した。

## 追記（2026-09-26、[Issue #779](https://github.com/takecchi/mnemora/issues/779)）

**この節は本文を書き換えない**（履歴を書き換えない）。決定・「引き受ける負債」の
🟠（ロール名＝スキーマ名）は、本 ADR の対象外として当時のまま残っている——ここに書くのは
その🟠を実際に直した記録である。

2026-09-26 にクローン miku（の委譲先）が、上の🟠の直し方として「`runMigrations`
（`migrate.ts`）と `registerEmbeddingSpace`（`vector-space.ts`）が、`schema` オプション
未指定かつ `options.lockKey` の上書きも無いときに限り、advisory lock を取得する**前**に
同じ `pool` で `SELECT current_schema()` を読み、その結果を既存の `migrationLockKeyFor`/
`registerEmbeddingSpaceLockKeyFor`（どちらも ADR 0057 決定6で新設した関数）へそのまま
渡す」形を採った。理由は、この2関数が「`schema` 未指定のとき実際にどのスキーマが
使われるかを静的には特定できない」という前提の上で固定キーへ倒していた（ADR 0057
「引き受ける負債」）のに対し、**実行時になら特定できる**——接続の `search_path` が
実際に解決した先を、その接続自身に問えばよいだけだったため。

**`schema` が `public` を見ているとき、既定キー（`MIGRATION_LOCK_KEY`/
`REGISTER_EMBEDDING_SPACE_LOCK_KEY`）のままにした。** 新旧の版が同時に `runMigrations`/
`registerEmbeddingSpace` を呼んでも互いに待ち合う——という ADR 0057 決定6 (a) の性質
（ローリングデプロイ中の互換性）を保つ線をそのまま引き継いだだけであり、狙って
分岐を書き足したわけではない。`migrationLockKeyFor("public")`/
`registerEmbeddingSpaceLockKeyFor("public")` はどちらも元から既定キーを返すので、
`current_schema()` が `"public"` を返した場合は何もしなくても同じキーに落ちる。

**ADR 0057 決定2（「`schema` を指定しない既定の経路は、発行される SQL が今日と同一
である」）から、小さな逸脱が増えた。** `options.lockKey` を上書きしない呼び出しは、
`schema` 未指定のときロック取得より前に `SELECT current_schema()` を1回発行する
——DDL・DML の内容には一切触れない、advisory lock のキーを選ぶためだけの読み取りである。
本 ADR の決定7の逸脱（拡張の共有ロックにまつわる `pg_advisory_lock`/`pg_advisory_unlock`
の増加、初回適用時限定）とは別の、独立した逸脱として積み上がる。

**ADR 0057「引き受ける負債」の「`schema` 未指定と `schema: "public"` を、advisory lock
については同じ対象として扱う」の根拠（(b) 未指定は静的には特定できない）は、この変更で
解けた**——静的にではなく実行時に読むことで特定できるようにしたため。ただし
`migrationLockKeyFor`/`registerEmbeddingSpaceLockKeyFor` 自身は同期関数のまま変えていない
（次の段落）。

**残る窓**: この変更が入る前後で、ロール名と同名のスキーマを見ている `schema` 未指定の
呼び出しは、旧版（常に既定キー）と新版（`current_schema()` を読んで導出キー）の間で
ロックキーが食い違う——移行期に両方のバージョンが同居すると、互いに待たない窓が残る。
`schema: "<明示指定>"` を経由する呼び出し同士や、新版同士・旧版同士は影響を受けない。

**採らなかった案**:

- **`search_path` に `"$user"` が含まれる場合を検査で弾く。** Issue #779 自身が候補として
  挙げていたが、これまで意図せず（あるいは意図して）ロール名と同名のスキーマへ書いて
  きた既存の呼び出しを、新しい例外で落とすことになる——挙動を変えないという線を破る。
- **`schema` 未指定のとき、既定キーと `current_schema()` から導出したキーの両方を取る
  （2本の advisory lock を保持する）。** 実装すれば上の「残る窓」も塞げる——旧版は
  常に既定キーを取るので、新版が両方取れば必ず旧版と鉢合う。今回は採らなかった。
  理由: 本 Issue が実測して示したのは「ロール名＝スキーマ名という、既に狭い条件」の
  中の、さらに「新旧混在という移行期」に限られる窓であり、常時2本のロックを取る
  コスト（`runMigrations`/`registerEmbeddingSpace` が同時に必要とする advisory lock の
  数が増える）に見合うほどの実測を、この委譲では行っていない。
- **`migrationLockKeyFor`/`registerEmbeddingSpaceLockKeyFor` を非同期化し、関数自身に
  `pool` を渡して `current_schema()` を読ませる。** 依頼で明示的に禁じられている
  ——この2関数は公開 API であり、シグネチャ・戻り値を変えると利用側の呼び出し（同期
  関数として扱っている既存コード）を破壊的に変えることになる。`resolveCurrentSchema`
  （`packages/postgres/src/resolve-current-schema.ts`、`index.ts` からは export しない
  内部 helper）を呼び出し側（`runMigrations`/`registerEmbeddingSpace`）に置くことで、
  2関数自体は同期のまま変えていない。

実装・テストの詳細は `packages/postgres/src/migrate.ts` の `migrationLockKeyFor` と
`runMigrations` の doc コメント、`packages/postgres/src/vector-space.ts` の
`registerEmbeddingSpaceLockKeyFor` と `registerEmbeddingSpace` の doc コメント、
`packages/postgres/src/__tests__/role-name-schema-lock-key.postgres.test.ts` を参照。
