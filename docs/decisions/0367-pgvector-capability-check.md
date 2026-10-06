# ADR 0367: pgvector の `hnsw.iterative_scan` 対応を、版の文字列ではなく能力で検査する

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1301](https://github.com/takecchi/mnemora/issues/1301) が指摘したとおり、
  `docs/memory-model.md`「前提: pgvector のバージョン」は `>= 0.8.0` を必須と書いているが、
  実装はどこでも版を検査していない。`packages/postgres/src/vector-store.ts` の
  `withRelaxedOrderScan`（`search()`/`searchMany()` が経由する唯一の箇所、ADR 0284）は、
  1トランザクション内で `SET LOCAL hnsw.iterative_scan = relaxed_order` を発行する。
  `hnsw.iterative_scan` は上流 pgvector の `src/hnsw.c` で **v0.8.0 で初めて**
  `DefineCustomEnumVariable` される（v0.7.4 には無い）。0.8.0 未満では:

  | pgvector | PostgreSQL | 起きること |
  |---|---|---|
  | < 0.5.0 | 問わない | HNSW 自体が無く、`registerEmbeddingSpace` の `CREATE INDEX ... USING hnsw` で落ちるはず |
  | 0.5.x | 問わない | `hnsw` 接頭辞が予約されない。`SET LOCAL` は黙って通り、iterative scan は効かない（静かな劣化） |
  | 0.6.0〜0.7.x | >= 15 | `hnsw` 接頭辞が予約される。初回の `SET LOCAL` は WARNING とともに捨てられて通るが、**同じ接続の2回目から ERROR** |
  | 0.6.0〜0.7.x | < 15 | 予約されず、0.5.x と同じ静かな劣化と推定 |

  Issue #1301 は方針の判断を私（クローン miku の委譲先）に委ねており、後続の委譲で
  マネージャー（別のクローン miku）が方針を確定した。本 ADR はその確定した方針の
  実装記録である——方針そのものの当否はマネージャーの判断であり、本 ADR は
  「どう実装したか・何を実測したか」を記録する。

- **決定**:

  ## 決定1: 検査の場所は2つ。`registerEmbeddingSpace` には置かない

  - **(a) `PostgresVectorStore` の `withRelaxedOrderScan`**——`search()`/`searchMany()` が
    `SET LOCAL hnsw.iterative_scan = relaxed_order` を発行する直前。`recall()` が実際に
    ERROR/劣化を踏むより必ず前に当たる。
  - **(b) `runMigrations`**（`packages/postgres/src/migrate.ts`）——`extensionMode` の
    `create`/`verify` 両方。デプロイ時に早く落とすための冗長な検査（(a) と独立に効く。
    `runMigrations` を呼ばずに `PostgresVectorStore` だけを使う構成もありうるため、
    どちらか一方だけでは足りない）。
  - **`registerEmbeddingSpace` には置かない**——`registerEmbeddingSpace` は
    `CREATE INDEX ... USING hnsw` を発行するだけで `hnsw.iterative_scan` には一度も触れない
    （ADR 0284 が `search()`/`searchMany()` だけに `relaxed_order` を効かせる設計を採った
    ことの裏返し）。ここに検査を置くと「関係ない場所で関係ない理由により失敗しうる」
    検査になり、`docs/north-star.md` 問い3（説明できるか）に反する。
  - **opt-out（検査を外す口）は付けない**——マネージャーの決定。`extensionMode: "verify"`
    （ADR 0093）のような「意図的に権限を絞った運用」を許す口とは性質が違う。pgvector が
    古いまま `relaxed_order` を使い続けることは、`recall()` の結果が壊れる（ERROR）か
    黙って劣化するかのどちらかであり、外部の運用制約ではなく実装のバグに近い——外す口を
    与えると、Issue #1301 が指摘した「静かな劣化に気づかないまま動き続ける」状態を
    そのまま存続させる口を新設することになる。

  ## 決定2: 版の文字列ではなく能力で判定する。判定は `pg_settings`、`current_setting` は使わない

  素朴には `pg_extension.extversion` を `>= 0.8.0` かどうかで比較するか、
  `current_setting('hnsw.iterative_scan', true)` を読んで「動くか」を確かめたくなる。
  だが後者には **placeholder の穴**がある——本 ADR のために、自分専用の
  PostgreSQL 17.11 + pgvector 0.8.0（`AGENTS.md`「手元で Postgres を立てる」の手順、
  `initdb`）で実測した。

  ### 実測1: 0.8.0 で `current_setting`/`pg_settings` がどう見えるか

  ```
  -- 同じ接続で vector を使った後
  SELECT '[1,2]'::vector <-> '[1,3]'::vector;                     -- 1
  SELECT current_setting('hnsw.iterative_scan', true);            -- off（既定値、'relaxed_order' ではない）

  -- vector を使う前（フレッシュな接続）
  SELECT current_setting('hnsw.iterative_scan', true);            -- (空 = NULL)

  -- pg_settings（vector を使った後）
  SELECT name, vartype, enumvals FROM pg_settings WHERE name = 'hnsw.iterative_scan';
  --         name         | vartype |             enumvals
  -- hnsw.iterative_scan  | enum    | {off,relaxed_order,strict_order}

  -- pg_settings（vector を使う前）
  -- 0 rows
  ```

  ⟹ **モジュールがロードされる（その接続で `vector` 型に一度でも触れる）まで、
  `hnsw.iterative_scan` は `pg_settings` に現れない。** 判定するなら、同じ SQL 文の中で
  `vector` を使ってから読む必要がある。

  ### 実測2: placeholder の危険（`current_setting` は区別できない、`pg_settings` は区別できる）

  一度も予約されない接頭辞の下に `SET LOCAL`／`ALTER DATABASE ... SET` で値を置くと、
  Postgres はそれを「まだ定義されていないパラメータの placeholder」として保持する
  （`hnsw` 自体で試すと 0.8.0 の実物では既に予約されているため、代理として
  `mnemora_probe.iterative_scan` という架空の接頭辞で再現した——Issue #1301 本文の
  `hnsw.no_such_param` の代理実測と同じ考え方）。

  ```
  -- (a) SET LOCAL で置いた placeholder
  BEGIN; SET LOCAL mnemora_probe.iterative_scan = 'relaxed_order';
  SELECT current_setting('mnemora_probe.iterative_scan', true);   -- 'relaxed_order'（危険）
  SELECT name, vartype, enumvals FROM pg_settings
    WHERE name = 'mnemora_probe.iterative_scan';                  -- 0 rows（安全）
  COMMIT;

  -- (b) ALTER DATABASE で置いた placeholder（新しいセッションでも残る）
  -- postgres= ALTER DATABASE mnemora_probe SET "mnemora_probe.iterative_scan" = 'relaxed_order';
  -- 新しいセッションで、一度も自分では SET していないのに:
  SELECT current_setting('mnemora_probe.iterative_scan', true);   -- 'relaxed_order'（危険。
                                                                    --   何も使っていないのに値が出る）
  SELECT name, vartype, enumvals FROM pg_settings
    WHERE name = 'mnemora_probe.iterative_scan';                  -- 0 rows（安全）
  ```

  ⟹ **`current_setting(name, true)` は placeholder の値もそのまま返し、本物の GUC と
  区別しない。** `postgresql.conf`／`ALTER DATABASE ... SET`／`ALTER ROLE ... SET`／
  同じ接続での過去の `SET` のいずれかで `hnsw.iterative_scan = relaxed_order`
  相当の値が置かれていると（例: 別の目的で書かれた設定ファイルの使い回し、コピペ）、
  `current_setting` ベースの検査は 0.8 未満でも「対応している」と誤って通ってしまう
  ——これが Issue #1301 の依頼者が名指しで懸念した穴である。

  **`pg_settings` は placeholder を一切載せない。** 実際にモジュールがロードされ、
  `DefineCustomEnumVariable` で定義された GUC だけが `vartype = 'enum'` の行として
  現れる。⟹ **判定は `pg_settings` の `vartype`/`enumvals` で行う。`current_setting` は
  一切使わない。**

  ### 実測3: 1往復に収まるか（`LATERAL` は要らない）

  ```sql
  SELECT ext.extversion AS extversion, s.vartype AS vartype, s.enumvals AS enumvals
  FROM (SELECT '[0]'::vector AS probe) AS load
  LEFT JOIN pg_extension ext ON ext.extname = 'vector'
  LEFT JOIN pg_settings s ON s.name = 'hnsw.iterative_scan'
  ```

  この1文で、`vector` を使う副問い合わせ（`load`）→ `pg_extension`/`pg_settings` の
  `LEFT JOIN` が同じ文の中で順に評価され、0.8.0 では `{extversion: "0.8.0", vartype:
  "enum", enumvals: ["off","relaxed_order","strict_order"]}` の1行が返ることを確認した。
  `LATERAL` は不要——単純な `LEFT JOIN` で足りる。`LEFT JOIN` にしたのは、`pg_settings`
  に行が無い場合（0.8 未満・拡張が無い等）でも常にちょうど1行を返すため
  （「0行だから未対応」と「クエリの形が壊れて0行」を呼び出し側で区別しやすくする）。

  この1文を `PGVECTOR_CAPABILITY_QUERY`（`packages/postgres/src/pgvector-capability.ts`）
  として (a)(b) 両方の唯一の発行元にした——文字列を2箇所に複製しない。

  ### 実測環境の限界

  手元には PostgreSQL 17.11 + pgvector 0.8.0（`initdb` で自分専用に構築、
  `AGENTS.md`「手元で Postgres を立てる」）だけがあり、0.7 系以下の実物はビルド道具
  （`make`・`gcc`）が無いため用意できていない。**0.6〜0.7.x・0.5.x での実測は、
  Issue #1301 本文と同じ「予約されない/既に予約された接頭辞の下で代理の名前を使う」
  代理実測に留まる。** 本物の 0.7.x・0.5.x に対する実測は、確かめていないこと節へ送る。

  ### `extversion` の扱い

  能力の判定には一切使わない。`PgvectorVersionUnsupportedError` のメッセージに
  「インストールされている版は分かる範囲で添える」ためだけに読む——
  `MissingExtensionsError`（`migrate.ts`、ADR 0093）が「足りない拡張名と実行すべき SQL を
  具体的に書く」のと同じ方針。

  ## 決定3: エラー型 `PgvectorVersionUnsupportedError`

  ```ts
  class PgvectorVersionUnsupportedError extends Error {
    readonly installed: string | undefined; // pg_extension.extversion。拡張行が無ければ undefined
    readonly required: string; // "0.8.0"
    readonly missingCapability: "hnsw.iterative_scan"; // 今のところ1種類だけ
  }
  ```

  `name = "PgvectorVersionUnsupportedError"`。メッセージには直し方
  （ライブラリを 0.8.0 以上へ上げる／`ALTER EXTENSION vector UPDATE;`）を具体的に書く。
  `packages/postgres/src/index.ts` から export し、`api:check`（`scripts/__snapshots__/
  public-api/postgres.d.ts`）のスナップショットを更新した。

  ## 決定4: (a) は成功のみキャッシュ、失敗はキャッシュしない

  `PostgresVectorStore` インスタンスごとに `PgvectorCapabilityGate`（`confirmed: boolean`）
  を1つ持ち、`search()`/`searchMany()` の両方の `withRelaxedOrderScan` 呼び出しで共有する。

  - **成功は覚える**——対応している状態は、そのプロセスの寿命の間まず覆らない
    （pgvector を「ダウングレードする」運用は通常無い）。覚えて往復を省く価値がある。
  - **失敗は覚えない**——対応していない状態では `search()`/`searchMany()` は既に毎回
    失敗しているため、失敗を覚えて検査を省略しても定常状態のコストは下がらない。
    覚えてしまうと、DBA が `ALTER EXTENSION vector UPDATE;` で直した後もプロセス再起動
    まで検査結果が固定されたままになる——得るものが無いまま自己修復しない欠点だけが残る。

  ## 決定5: (b) の `create` モードは「何も適用しないうちに投げる」を保証できない

  `runMigrations` の `extensionMode: "verify"` は、`vector` 拡張の存在確認
  （`verifyRequiredExtensions`）の直後・advisory lock 取得より**前**に能力検査する
  ——`verify` は `CREATE EXTENSION` を発行しないだけで `SELECT`（能力検査）は打てるため、
  拡張の存在さえ確認できれば、マイグレーション本文には一切触れずに検査を完了できる。

  `extensionMode: "create"`（既定）は、これができない場合がある。`schema` を指定した
  呼び出しは `CREATE EXTENSION` を早い段階（`CREATE SCHEMA` の直後）で発行するが、
  `schema` 未指定（最も一般的な既定経路）では、新規インストール時に `vector` 拡張
  そのものが `migrations/0001_init.sql` 本文の適用によって初めて作られる——つまり
  「拡張が存在する」という能力検査の前提が、最初のマイグレーション適用**後**にしか
  成立しない。

  ⟹ **`create` モードの検査は、`runMigrations` の末尾（全マイグレーション適用後、
  advisory lock 解放前）に置く単一の呼び出し**にした。理由:

  - `schema` 有無・新規/継続インストールのどちらでも同じコードパスで動く単一の経路にできる。
  - **既に全マイグレーション適用済みの定常状態**（`runMigrations` を毎回の起動時に呼ぶ
    運用で最も多いケース）でも、呼び出しのたびに必ず検査する——「新規インストール時だけ
    検査する」設計だと、デプロイ後に pgvector をダウングレードされるような稀なケースを
    一生拾えない。
  - 代償として、新規インストールでは「マイグレーション本文が何も流れないうちに落ちる」
    という理想を満たせない——0001_init.sql 等は実際に適用された**後**で例外になる
    （`_mnemora_migrations` 台帳への記録も含め、DDL 自体は commit 済み）。
    `PgvectorVersionUnsupportedError` を捕まえて `ALTER EXTENSION vector UPDATE;` を
    実行し、`runMigrations` を再実行する分には副作用は無い（migrate は冪等）。

  この非対称（`verify` は本当に「何も適用しない」を守れるが、`create` は守れない場合がある）
  は、テスト（`extension-mode.test.ts`）で両方向とも明示的に固定してある。

- **確かめていないこと**:

  - **本物の pgvector 0.5.x・0.6.0〜0.7.x に対する実測は無い。** 上の「実測環境の限界」の
    とおり、代理実測（予約されない/既に予約された接頭辞の下で架空の名前を使う）に留まる。
    Issue #1301 本文が示した「0.6〜0.7 × PG15+ は初回だけ通り2回目から ERROR」
    「0.5.x・PG<15 は静かな劣化」という挙動そのものは、この ADR では再現していない
    （上流ソースからの推論と、代理実測の組み合わせのまま）。
  - **マネージド Postgres 各社が実際にどの pgvector 版を提供しているか**は確かめていない
    （`docs/memory-model.md` の同節が既に「確かめていないこと」として書いている、
    この ADR でも変わらない）。
  - **`hnsw` 以外の接頭辞を pgvector の将来のマイナー版が予約し直す可能性**は検討していない
    ——`PGVECTOR_CAPABILITY_QUERY` は `hnsw.iterative_scan` という固定名に依存している。

- **採らなかった案**:

  - **`extversion` の数値比較（`.` 区切りで分解して比較）を主判定にする案**——(a)(b) の両方で
    能力ベースの判定（決定2）が成り立つことを実測で確認できたため、不要になった。
    版の数値比較には、`ALTER EXTENSION vector UPDATE;` をまだ実行していないだけで
    ライブラリ自体は新しい（`extversion` が古いまま報告される）構成を誤って弾く
    という別の弱点もある——能力ベースの判定はこれも正しく通す。
  - **検査を外す opt-out を用意する案**——決定1で却下（理由は同節）。
  - **`registerEmbeddingSpace` に検査を置く案**——決定1で却下（`hnsw.iterative_scan` に
    一度も触れない場所であり、検査する理由が無い）。

- **引き受けた負債**:

  - `create` モードは新規インストール時に「何も適用しないうちに投げる」を満たせない
    （決定5）。
  - 0.5.x・0.6〜0.7.x の実物に対する実測が無いまま、代理実測だけで能力ベースの判定を
    採用している。

## 追記（2026-10-07、[Issue #1780](https://github.com/takecchi/mnemora/issues/1780)）: `runMigrations` の能力検査は、`schema`/`extensionSchema` の `search_path` の下で流す

**この判断はクローン（miku）の判断であり、オーナーの判断ではない。**

- **何が起きていたか**: `runMigrations` に `schema` と、`public` 以外の `extensionSchema` を渡し、
  `vector` がその `extensionSchema` に在ると、検査が `type "vector" does not exist` で落ちた
  （`create` は末尾の検査、`verify` はロック取得前の検査。**どちらも実測で落ちた**）。
  検査の SQL は `'[0]'::vector` と型を修飾せずに書き、各ファイルを流すときの
  `SET LOCAL search_path TO <schema>,<extensionSchema>` の**外**で流れ、接続の既定の
  `search_path`（`"$user", public`）に `extensionSchema` が入っていないため。
  決定の文脈は「`vector` は `public` にある」を暗黙に置いていた。
- **決めたこと**: 検査を流す所で、`schema` を指定した呼び出しに限り、
  `BEGIN` → `SET LOCAL search_path TO <各ファイルと同じ>` → 検査 → `COMMIT`（失敗したら `ROLLBACK`）で囲む。
  `SET LOCAL` なので、トランザクションを抜けると接続の `search_path` は元に戻る。
  `verify` は pool から接続を1本借りて同じことをし、返す。**`schema` 未指定の呼び出しは
  `search_path` に一切触れない**（発行される SQL は今日と同じ）。
- **`PGVECTOR_CAPABILITY_QUERY` は変えない**: `vector-store.ts` も同じ文字列を使い、
  そちらは `extensionSchema` を知らない（検索は呼び出し側の接続の `search_path` に任せている）。
  `vector-store.ts` の振る舞いは1バイトも変わらない。公開 API の型・export も変わらない
  （`dist` の `.d.ts` は変更前後で同一）。
- **採らなかった案**: (a) 検査の SQL で型を `"<extensionSchema>".vector` と修飾する案。
  共有の定数を、`vector-store.ts`（`extensionSchema` を持たない）と分けるか、引数にする必要があり、
  `vector-store.ts` の発行 SQL が変わる。(b) は `migrate.ts` の中で閉じる。
- **引き受けた負債**: `schema` を指定した呼び出しで、検査のために往復が `BEGIN`・`SET LOCAL`・`COMMIT`
  の3つ増える（`create` は定常状態でも毎回検査するため、毎回）。
  `vector-store.ts` の検査（`withRelaxedOrderScan` の前）は、`vector` が呼び出し側の接続の
  `search_path` に無いと同じ形で落ちうるが、**手元では確かめていない**（この追記の範囲外）。
