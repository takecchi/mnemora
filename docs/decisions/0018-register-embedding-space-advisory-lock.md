# ADR 0018: `registerEmbeddingSpace()` を advisory lock でプロセス間排他する

- **状態**: 採用 (2026-09)

- **文脈**:

  ADR 0017 は `runMigrations()` の排他を実装した際、`packages/postgres/src/vector-space.ts`
  の `registerEmbeddingSpace(pool, space)` を「同じ性質（`CREATE TABLE IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS` を使っており、非アトミックな可能性が高い）が当てはまる
  疑いがあるが、実測はしていない」と「確かめていないこと」に残した。
  `examples/chat/src/runtime-factory.ts` は `runMigrations()` の直後にこれを呼んでおり、
  複数レプリカが同時に起動する経路では、この呼び出しが次の衝突点として残っていた。

  **段階1（この ADR より前に実施）で実測した。** 本物の PostgreSQL 17.9 + pgvector 0.8.2
  （ghcr.io の homebrew bottle、glibc 2.35 ビルドを名指しで取得。embedded-postgres で
  root 無しに構築）に対して、まっさらな DB を試行ごとに `DROP DATABASE ... WITH (FORCE)`
  → `CREATE DATABASE` で作り捨て、`runMigrations()` を単一プロセスで直列に通してから
  （`registerEmbeddingSpace` の FK 先である `memories` テーブルを用意するため）、
  子プロセスを N 本、本当に `child_process.spawn` で fork し（同一プロセス内の
  `Promise.all` ではない）、全員が接続を終えてから壁時計のバリア時刻で足並みを揃えて
  `registerEmbeddingSpace(pool, space)` を同時に撃った。

  **結果は決定的だった。**

  | 実験 | 並行度 | 試行 | 失敗（1プロセス以上落ちた試行） |
  | ---- | ------ | ---- | ------------------------------- |
  | 対照 | 1      | 6    | 0/6                             |
  | 並行 | 2      | 12   | 12/12（毎回ちょうど1本失敗）    |
  | 並行 | 4      | 12   | 12/12（毎回ちょうど3本失敗）    |

  子プロセス間の起動時刻差（バリア到達時刻の差）は全78観測で0ms。DDL の所要時間は
  成功・失敗とも一桁ミリ秒（成功 median 9.05ms、失敗 median 7.97ms）で、遅延起因の
  見かけの直列化ではなく実際の競合であることを確認している。

  **主実験（`registerEmbeddingSpace` をそのまま並行呼び出し）で失敗した48プロセス
  全件が同一のエラーだった**（負けたプロセスは1文目の `CREATE TABLE IF NOT EXISTS`
  で例外を投げ、2文目の `CREATE INDEX IF NOT EXISTS` には到達しない）:

  ```
  errorMessage: 'duplicate key value violates unique constraint "pg_type_typname_nsp_index"'
  sqlstate: "23505"
  constraint: "pg_type_typname_nsp_index"
  table: "pg_type"  (schema: pg_catalog)
  detail: "Key (typname, typnamespace)=(memory_embeddings_test_concurrency_fixture_8, 2200) already exists."
  ```

  **索引層（`CREATE INDEX IF NOT EXISTS`）も独立に非アトミックかを切り分けるため、
  補助実験を追加した**——テーブルは単一プロセスで先に直列に作ってから、
  `CREATE INDEX IF NOT EXISTS`（vector-space.ts の第2文と同じ SQL）だけを並行度2/4で
  各6試行、計12試行走らせた。**こちらも12/12決定的**で、毎回ちょうど1本だけ成功。
  エラーは第1層とは別の対象:

  ```
  errorMessage: 'duplicate key value violates unique constraint "pg_class_relname_nsp_index"'
  sqlstate: "23505"
  constraint: "pg_class_relname_nsp_index"
  table: "pg_class"
  detail: "Key (relname, relnamespace)=(idx_memory_embeddings_hnsw_test_concurrency_fixture_8, 2200) already exists."
  ```

  **つまり衝突点はテーブル層・索引層の両方に独立して存在する。** ただし主実験
  （まっさらな DB へ `registerEmbeddingSpace` をそのまま並行呼び出し）だけを見ると
  索引層の衝突は**見えない**——テーブル層で先に片方が落ちるため、負けたプロセスは
  2文目に到達しない。これは ADR 0017 が `runMigrations` で見た「層を1つずつ剥がさないと
  次の層が見えない」構造と同じ形である。

  失敗後の DB 状態は全30トライアル（主実験）で完全に一貫していた（テーブル・索引とも
  揃って存在し、中途半端な状態は一度も観測しなかった）。`deadlock detected`（40P01）や
  `tuple concurrently updated` は一度も観測しなかった。

  段階1の実験ハーネスは `/home/worker/mgr-a692b311/experiments/`（このリポジトリの
  外）にある。生データは `/home/worker/mgr-a692b311/experiments/results/*.jsonl`
  （`control.jsonl` / `concurrent2.jsonl` / `concurrent4.jsonl` / `index-only.jsonl`）
  に残っている。

- **検討した選択肢**:

  1. **個々の DDL に対策を積み増す。** ADR 0017 が `runMigrations` で既に実測して
     否定した方向であり、`registerEmbeddingSpace` でも同じ結論になる——
     `IF NOT EXISTS` 自体が並行では非アトミックなので、対策を積んでも症状が
     移るだけで「並行に呼んでよい」保証にはならない。**採らない。**

  2. **`runMigrations` とは独立に、`registerEmbeddingSpace` 専用の排他機構を
     新しく実装する。** 機構そのもの（advisory lock の取得・解放・3状態の区別・
     `lock_timeout` の設定と後始末）は `runMigrations` で既に実証済みであり、
     同じ設計をもう一度別の実装で書くのは「学ぶことを1つで済ませる」という
     要求に反する。**採らない。**

  3. **`runMigrations` が使う advisory lock の機構を共通モジュール
     （`packages/postgres/src/advisory-lock.ts`）へ切り出し、`registerEmbeddingSpace`
     からも使う（採用）。** ロックキーは別の値を新設し、2つの関数が互いを
     無関係にブロックしないようにする。

- **決定**:

  `acquireMigrationLock` / `releaseMigrationLock`（`migrate.ts` に元々あった private
  関数）の中身を `packages/postgres/src/advisory-lock.ts` の
  `acquireAdvisoryLock` / `releaseAdvisoryLock` として切り出した。専用コネクションを
  pool から借り切る・`set_config('lock_timeout', ...)` を session に敷く・失敗時は
  必ず release してから投げる・終了時に `lock_timeout` を `'0'` へ戻す、という
  ADR 0017 が実装した性質は**そのまま保った**（理由のコメントごと移設した）。

  - **エラーの語彙を共有した。** 汎用の `AdvisoryLockTimeoutError` /
    `AdvisoryLockUnavailableError` を `advisory-lock.ts` に置き、
    `migrate.ts` の `MigrationLockTimeoutError` / `MigrationLockUnavailableError` は
    それぞれのサブクラスとして残した（既存の `instanceof` 検査とメッセージ文言は
    変えていない）。`vector-space.ts` にも同様に
    `RegisterEmbeddingSpaceLockTimeoutError` / `RegisterEmbeddingSpaceLockUnavailableError`
    を新設し、同じ基底クラスのサブクラスにした——呼び出し元は
    `instanceof RegisterEmbeddingSpaceLockTimeoutError` で「待って取れた／時間切れ／
    ロック取得そのものが失敗」の3状態を、`runMigrations` と同じ語彙で区別できる。
  - **ロックキーは新設し、`MIGRATION_LOCK_KEY` とは別の値にした**:
    `REGISTER_EMBEDDING_SPACE_LOCK_KEY = -4359922960011245935n`
    （固定文字列 `"mnemora:registerEmbeddingSpace:advisory-lock"` の SHA-256
    先頭8バイトを符号付き64bit整数として解釈した値。`MIGRATION_LOCK_KEY` と
    **同じ導出手順**。`packages/postgres/src/vector-space.ts` に再計算コマンド付きで
    コメントしてある）。`runMigrations` と `registerEmbeddingSpace` が互いを
    無関係にブロックしないようにするため——同じキーにすると、例えば
    「マイグレーション中の別プロセス」が「埋め込み空間を登録しようとした
    プロセス」を意図せず待たせることになる。
    **埋め込み空間ごとにキーを分けることはしなかった**（`EmbeddingSpaceId` から
    導出したりしない）。`registerEmbeddingSpace` の呼び出しは稀（起動時に一度程度）で
    DDL 自体も軽い（段階1の実測で1桁ミリ秒）ため、キー空間を空間の数だけ増やす
    複雑さのほうが、別空間の同時登録がロックの奪い合いで直列化されるという
    実害の小ささに見合わない、という判断。**引き受けるトレードオフ**: 埋め込み
    空間が仮に多数あり、起動時にすべて並行して `registerEmbeddingSpace` を
    呼ぶような使い方をすると、空間ごとの登録が意図せず直列化される（並列性の
    低下であって、正しさが壊れるわけではない）。これが問題になるほど空間数が
    増えたら、キーを空間ごとに分ける方向を再検討すること。
  - **戻り値を `runMigrations` と同じ形にした**: `registerEmbeddingSpace` は
    これまで `Promise<void>` を返していたが、`Promise<{ lock: { waitedMs: number } }>`
    に変えた（フィールドの追加ではなく、そもそも戻り値が無かったところに追加した
    形——既存の呼び出し側は戻り値を使っていないため、破壊的変更ではない。
    `examples/chat/src/runtime-factory.ts` の `await registerEmbeddingSpace(...)`、
    `packages/postgres/src/__tests__/test-db.ts` /
    `examples/chat/src/__tests__/test-db.ts` の同名呼び出し、いずれも戻り値を
    見ていないため無変更で通った）。
  - **バリデーションはロック取得より前に置いた**（`dimensions` の検査・
    `assertSafeIdentifier`）。不正な入力のためにロックを取って他プロセスを
    待たせる意味が無いため。

- **理由**:

  段階1の実測が示す通り、`registerEmbeddingSpace` の非アトミック性は
  `runMigrations` と**同じ性質**（`IF NOT EXISTS` は並行では非アトミック）から
  来ている。同じ性質には同じ機構で対応するのが、オーナーの要求
  （「学ぶことが1つで済む」）にも、コードの重複を避ける観点にも合う。

- **歯（この決定を測る歯）**:

  `packages/postgres/src/__tests__/vector-space-concurrency.test.ts` を新設した。
  `migrate-concurrency.test.ts` と同じ構造（テストごとに独立したデータベースを作る・
  `lockKey` を it ごとに変える理由も同じ）。5本:

  - **歯1a**: まっさらな DB へ4プロセス相当（別々の `Pool`）を同時に
    `registerEmbeddingSpace` → 全員成功し、テーブル・索引が正しく1組だけ出来ている。
    段階1の実測では、この形（まっさらな DB へ N=4 同時）はテーブル層
    （`pg_type_typname_nsp_index`）で12/12決定的に落ちた経路に対応する。

  - **歯1b**: テーブルだけ先に1プロセスで直列に作っておき（索引は作らない）、
    4プロセス相当が同時に `registerEmbeddingSpace` を呼んでも、全員成功し索引が
    正しく1本だけ出来ている。段階1の補助実験（索引層単体、N=2/4で12試行決定的）に
    対応する経路。

    **なぜ「テーブルと索引を両方先に作っておく」ではなく「テーブルだけ」なのか**:
    最初は「テーブルと索引を両方先に作ってから2回目以降の冪等な経路として
    並行に呼ぶ」形を想定していたが、**実測したところこの形では変異
    （ロックを外す）を当てても赤くならなかった**——`registerEmbeddingSpace` を
    1回成功させて索引まで作ってしまうと、2回目以降の `CREATE TABLE IF NOT
EXISTS` / `CREATE INDEX IF NOT EXISTS` はどちらも「既に存在する」ことが
    コミット済みで全セッションから見えるため、非アトミックな競合そのものが
    起こらず（両方とも即座に no-op で抜けるだけ）、歯が変異を検知できなかった。
    索引だけ未作成の状態を作ることで、変異版が索引層の衝突を確実に踏むように
    した（実測して踏むことを確認した上で採用した形）。

  - **歯2**: 別セッションが advisory lock を握り、1.5秒後に手放す →
    `registerEmbeddingSpace` は待ってから成功し、`lock.waitedMs` に待った時間が乗る。

  - **歯3**: 別セッションが advisory lock を握ったまま手放さない →
    300ms のタイムアウトで `RegisterEmbeddingSpaceLockTimeoutError` を投げる
    （黙って続行して成功しない）。時間切れ後、DB には何も作られていないことも確認する。

  - **歯4**: `pg_advisory_lock(bigint)` の EXECUTE 権限を PUBLIC から剥奪した
    データベースで、非 superuser の制限ロールから呼ぶ →
    `RegisterEmbeddingSpaceLockUnavailableError` を投げる（歯3の時間切れとは
    別のエラー）。

  **変異試験**: 実装後、`registerEmbeddingSpace` から advisory lock の取得・解放を
  外す変異（`acquireAdvisoryLock` / `releaseAdvisoryLock` の呼び出しを削り、
  `waitedMs` を固定で `0` にするだけ）を当てたところ、**5本とも赤くなった**:

  ```diff
  --- (排他あり・修正後)
  +++ (排他を外した変異)
  @@ -138,14 +138,11 @@
     const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
     const lockKey = options.lockKey ?? REGISTER_EMBEDDING_SPACE_LOCK_KEY;
  -
  -  const { client: lockClient, waitedMs } = await acquireAdvisoryLock(
  -    pool,
  -    lockKey,
  -    lockTimeoutMs,
  -    REGISTER_EMBEDDING_SPACE_LOCK_ERRORS,
  -  );
  -  try {
  +  void lockTimeoutMs;
  +  void lockKey;
  +  // MUTATION: 排他を外す。
  +  {
       await pool.query(`
         CREATE TABLE IF NOT EXISTS ${table} (
  @@ -166,9 +163,7 @@
           ON ${table}
           USING hnsw (embedding vector_cosine_ops);
       `);
  -  } finally {
  -    await releaseAdvisoryLock(lockClient, lockKey);
     }
  -
  -  return { lock: { waitedMs } };
  +  return { lock: { waitedMs: 0 } };
   }
  ```

  変異を当てた状態での出力（5本とも失敗、SKIP は無い）:

  ```
  ❯ src/__tests__/vector-space-concurrency.test.ts (5 tests | 5 failed)
    × まっさらな DB へ4プロセス相当が同時に registerEmbeddingSpace しても、全部成功しテーブル・索引が1組だけ出来ている
      error: duplicate key value violates unique constraint "pg_type_typname_nsp_index"
        at registerEmbeddingSpace src/vector-space.ts:148:5
    × テーブルだけ先に作った状態で4プロセス相当が同時に呼んでも、全部成功し索引が1本だけ出来ている
      error: duplicate key value violates unique constraint "pg_class_relname_nsp_index"
        at registerEmbeddingSpace src/vector-space.ts:161:5
    × 先客が手放すまで待ってから進み、待った時間が戻り値に出る
      AssertionError: expected 7 to be greater than or equal to 750
    × 先客が手放さないと、短いタイムアウトで RegisterEmbeddingSpaceLockTimeoutError を投げる
      AssertionError: promise resolved "{ lock: { waitedMs: +0 } }" instead of rejecting
    × advisory lock を取る権限が無いロールで呼ぶと、RegisterEmbeddingSpaceLockUnavailableError を投げる
      AssertionError: expected error: permission denied for schema public { …(15) } to be an instance of RegisterEmbeddingSpaceLockUnavailableError

   Test Files  1 failed (1)
        Tests  5 failed (5)
  ```

  **歯1a・1bが変異で赤くなったエラーは、段階1の実測で自然な形の race が
  決定的に踏んでいたのと同じ衝突点である**——歯1aは `pg_type_typname_nsp_index`
  （テーブル層）、歯1bは `pg_class_relname_nsp_index`（索引層）。歯が実際に
  段階1で実測した壊れ方を、両層とも再現して検知していることの裏付けになっている。

  変異を戻すと5本とも緑に戻ることを確認した（この PR に含まれるコードは排他ありの
  状態であり、変異は一時的に当てただけで残していない）。

  **scram-sha-256 認証下での再検証**: ADR 0017 は CI（scram 認証）と手元
  （元は `trust`）の非対称のために歯4のパスワード関連の欠陥を手元で検出できなかった
  経緯があった。同じ落とし穴を踏まないよう、`vector-space-concurrency.test.ts` は
  最初から `migrate-concurrency.test.ts` の修正後の形（`connectionStringFor` が
  `user` と `password` を常に対で受け取る）をそのまま踏襲して書いた。そのうえで、
  手元の PostgreSQL の `pg_hba.conf` を一時的に `password` から `scram-sha-256` へ
  切り替え、管理ロールにもパスワードを設定した状態で `pg_reload_conf()` し、5本を
  通しで走らせたところ**5本とも緑だった**。さらに排他を外す変異を当て直したところ、
  scram-sha-256 環境下でも**5本とも再び赤くなった**（歯4は `trust`/`password`
  環境と同じ `permission denied for schema public` で失敗——advisory lock を経ずに
  `CREATE TABLE` へ進んでしまい、その段でロール自身の権限不足に当たったため）。
  検証後、`pg_hba.conf` は元の設定（`password`）へ戻してある。
  **手元の既定の認証方式が `trust` ではなく `password`（パスワードを検査する）
  だったこと自体も、この確認の過程で判明した**（ADR 0017 の記述は器が違う別環境
  だったための食い違いの可能性がある。今回使った embedded-postgres インスタンスの
  既定を指す）。

- **結果（この決定が招くもの）**:

  - `registerEmbeddingSpace()` は、他プロセスが同時に呼んでいない通常時でも
    advisory lock の取得・解放のために追加で2往復の通信を要する（`runMigrations`
    と同じ増分の形。実測した所要時間の増分は PR 本文を参照）。
  - `registerEmbeddingSpace()` の戻り値の型が `Promise<void>` から
    `Promise<{ lock: { waitedMs: number } }>` に変わった（既存の呼び出し側は
    戻り値を使っていないため破壊的変更ではない）。
  - `packages/postgres/src/migrate.ts` の private だった `acquireMigrationLock` /
    `releaseMigrationLock` の中身が `packages/postgres/src/advisory-lock.ts` の
    `acquireAdvisoryLock` / `releaseAdvisoryLock` に移った。`migrate.ts` 側は
    同名の薄いラッパー関数として残してあり、外部から見た `runMigrations` の
    振る舞い・エクスポートは変わっていない。
  - `examples/chat/src/runtime-factory.ts` のコメントを実態に合わせて修正した
    （旧コメントは「`registerEmbeddingSpace` はまだこの排他の対象外——次の衝突点
    として残っている」と書いていたが、塞いだので直した）。
  - ADR 0017 の「確かめていないこと」の該当項目を、この ADR を指す形へ更新した
    （当時の記録自体は書き換えず、取り消し線＋注記の形で残した）。

- **これが覆るとしたら**:

  - advisory lock のキー空間をアプリケーションの別の場所で使い始めたとき
    （ADR 0017 と同じ理由）。
  - 埋め込み空間の数が増え、起動時に多数の空間を並行して登録する使い方が
    現実的になったとき（現在は単一キーで直列化する判断だが、これが並列性の
    ボトルネックになるなら、空間ごとにキーを分ける方向を再検討する）。
  - `registerEmbeddingSpace()` の外側でも `memory_embeddings_*` テーブル・索引へ
    直接触る経路が増えたとき（advisory lock は `registerEmbeddingSpace()` を
    経由する呼び出し同士でしか効かない）。

- **確かめていないこと**:

  - **より高い並行度（N=8, 16 等）は測っていない。** 段階1・段階2ともに N=1/2/4 の
    みで検査した。
  - **次元数・provider/model の組み合わせは1パターンのみ。** 段階1は
    `dimensions=8`、段階2の歯は `dimensions=4` の固定値でのみ検査しており、
    他の次元・識別子の組み合わせでの再現性は確認していない。
  - **索引層単体を切り出した段階1の補助実験は、主実験（12試行）より少ない
    試行数（N=2/4 各6試行、計12試行）で確認した。** 決定的な結果ではあるが、
    主実験と同じ水準の試行数までは揃えていない。
  - **`assertSafeIdentifier` や `dimensions` のバリデーション自体が並行で
    問題を起こすか**は見ていない。常に同一の正常な `space` 引数だけを使った。
  - **advisory lock を取得する専用コネクションが極端に不健全な状態に陥ったときの
    挙動**は ADR 0017 と同様、この ADR でも検証していない（`registerEmbeddingSpace`
    固有の問題ではなく `pool.connect()` 全般に共通する話であるため）。
  - **手元の門は、既定では CI と同じ認証方式（scram）を測っていない。** 今回
    `pg_hba.conf` を一時的に `scram-sha-256` へ切り替えて個別に検証したが、これは
    通常の門の実行経路には含まれていない一回限りの手動確認であり、ADR 0017 が
    指摘した非対称自体は解消していない。

## 追記（2026-09-25、Issue #755）: より高い並行度（N=8/16/32）と、次元数・provider/model の組み合わせを実測した

この追記は、クローン（miku）の委譲で動くセッションが書いた。オーナー本人ではない（ADR 0220）。
上の本文は書き換えず、ここに実測だけを積む。「確かめていないこと」の最初の2項目
（N=8,16等が未測定／次元数・provider/model の組み合わせが1パターンのみ）を閉じる。

### 何を測ったか

段階1と同じ形——本物の PostgreSQL 17.11 + pgvector（`initdb` で自分専用に構築、AGENTS.md
「手元で Postgres を立てる」の手順そのまま）に対して、試行ごとにまっさらな DB を作り、
`runMigrations()` を単一プロセスで直列に通してから、`child_process.spawn` で N 本の
子プロセスを立て、全員が接続を終える（IPC で "ready" を送る）まで待ってから、壁時計の
バリア時刻を IPC で配って一斉に `registerEmbeddingSpace(pool, space)` を撃った。

ハーネスは `packages/postgres/.measure/`（このブランチの作業ツリー内・**コミットしていない**）
に置いた。生データ（JSONL）も同じ場所にあり、**この追記が唯一の永続的な記録である**
（ADR 0018 段階1のハーネスが repo 外に置かれ、後のセッションから参照できなくなっていたのと
同じ理由で、今回は数値をこの追記に実測記録として残す方針にした）。

### A. 並行度（N=8/16/32、SPACE は歯と同じ固定値 + 独自の `measure755-concurrency` モデル名）

**現行実装（ロックあり）**: 15試行 × 各 N。全試行・全プロセスが成功し、DB は常にテーブル1・索引1に収束した。

| N   | 試行 | 成功/総呼び出し | waitedMs 中央値 | waitedMs 最大 |
| --- | ---- | --------------- | --------------- | ------------- |
| 8   | 15   | 120/120         | 39ms            | 96ms          |
| 16  | 15   | 240/240         | 72ms            | 151ms         |
| 32  | 15   | 480/480         | 164ms           | 344ms         |

**対照（advisory lock の取得・解放を外した変異。ADR 0018 の変異と同じ diff）**: 同じ15試行 × 各 N。
**全45試行が例外なく失敗を含んだ**（N=8/16/32 いずれも「全員成功」の試行は1本も無かった）。

| N   | 試行 | 成功/総呼び出し | 失敗/総呼び出し |
| --- | ---- | --------------- | --------------- |
| 8   | 15   | 16/120          | 104/120         |
| 16  | 15   | 21/240          | 219/240         |
| 32  | 15   | 38/480          | 442/480         |

変異版の失敗の内訳（3水準合計、765件）:

| SQLSTATE / constraint                                   | 件数 | 備考                                                |
| ------------------------------------------------------- | ---- | --------------------------------------------------- |
| `23505` / `pg_type_typname_nsp_index`                   | 716  | ADR 0018 段階1で確認済みの経路（テーブル層）        |
| `42710`（duplicate_object）"type ... already exists"    | 25   | **ADR 0018 段階1（N=2/4）では観測されなかった経路** |
| `23505` / `pg_class_relname_nsp_index`                  | 5    | ADR 0018 段階1で確認済みの経路（索引層）            |
| `42P07`（duplicate_table）"relation ... already exists" | 19   | **同上、未観測だった経路**                          |

`42710` / `42P07` は根の原因（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` の
「存在確認」と「作成」が非アトミック）は `23505` の2種と同じだが、**存在確認そのものが
衝突を検知して投げるエラー**であり、カタログの一意制約違反とは別の SQLSTATE になる。
並行度が上がるほど、この経路（存在確認どうしが衝突する側）を踏む試行が増えたと見られる
（N=4以下では踏まれなかったか、踏んでも観測に上らない頻度だった可能性がある——
どちらかは今回の実測だけでは切り分けていない）。

**mutation-した状態でも DB の最終状態は45試行すべてでテーブル1・索引1に収束していた**
（部分的に壊れた状態・テーブルだけ複数残る等は一度も観測しなかった。ADR 0018 本文の
「全30トライアルで完全に一貫していた」が N=8/16/32・45試行でも保たれることを確認した）。

**固定 SPACE 以外でも同じ排他が要ることのスポットチェック**（N=8、各6試行、変異あり）:
`{provider:"openai", model:"text-embedding-3-large", dimensions:1536}` と
`schema:"tenant_measure755"` を指定した空間のどちらも、**全12試行で例外なく1/8だけ成功**
（7/8失敗）——固定テストフィクスチャの SPACE に限った現象ではないことを確認した。

**歯を1本足した**: `packages/postgres/src/__tests__/vector-space-concurrency.test.ts` に
「N=8プロセス相当が同時に registerEmbeddingSpace しても、全部成功しテーブル・索引が1組だけ
出来ている」を追加した（歯1aと同じ経路をN=8で固定する）。変異（ロックを外す）を当てると
既存5本と合わせて6本とも赤くなり、変異を戻すと6本とも緑に戻ることを確認済み
（出力はPR本文に記載）。N=16/32は歯までは足していない（1試行あたりの所要時間が伸びるため、
このADR追記に測定結果を残すだけに留めた）。

### B. 次元数・provider/model・schema の組み合わせ（N=8、現行実装、各1試行の到達確認）

| 組み合わせ                                                                                  | 結果                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dimensions=1`（`measure755`/`dims-min`）                                                   | 8/8 成功                                                                                                                                                                                                                                       |
| `dimensions=4`                                                                              | 8/8 成功                                                                                                                                                                                                                                       |
| `dimensions=8`                                                                              | 8/8 成功                                                                                                                                                                                                                                       |
| `dimensions=384`（`openai`/`text-embedding-3-small`）                                       | 8/8 成功（テーブル名51byte）                                                                                                                                                                                                                   |
| `dimensions=1536`（`openai`/`text-embedding-3-large`）                                      | 8/8 成功（テーブル名52byte）                                                                                                                                                                                                                   |
| `dimensions=2000`（`local-embedding`/`bge-small`、pgvector の hnsw 索引の次元上限ちょうど） | 8/8 成功——**2000 は有効な境界（含む）であることを確認**                                                                                                                                                                                        |
| `dimensions=3072`（63byte識別子ちょうど、切り詰め無し）                                     | **テーブル作成は8/8とも成功**（識別子の境界そのものは通った）が、**索引作成は8/8とも失敗**（後述 C-2 と同じ原因、`dimensions=3072>2000` が独立に効いている。63byte境界と2000次元上限が同じ組み合わせで重なった——狙って分離した値ではなかった） |
| `schema="tenant_measure755"` 指定（`dimensions=8`）                                         | 8/8 成功（指定したスキーマの中にテーブル・索引が作られた）                                                                                                                                                                                     |
| **別々の空間（8個、次元も別々）を同一DBへ同時登録**                                         | 8/8 成功、8テーブルとも作成。**8件全員の `waitedMs` が0より大きかった**——ADR 0018 が引き受けたトレードオフ（単一ロックキーのため別空間の同時登録も直列化される）どおりの挙動を実測で確認した                                                   |

### C. 形の上の副次の疑い

**C-1（63byte切り詰め後の名前の衝突）**: 44byte共通の接頭辞を持ち、末尾だけ異なる provider を
持つ2つの空間（`provider-with-a-very-long-descriptive-vendor-name-aaaa...`）を作り、
N=2 で同時登録した。切り詰め後の名前は `..._2b31d212` と `..._7795fd0b` で**異なり、
衝突は起きなかった**（両方とも正しく作成された）。`embedding-space-table.ts` のハッシュが
切り詰め前の生スラグ全体から計算される設計どおりの結果——**見つからなかった**。

**C-2（dimensions>2000 で hnsw 索引作成が落ちるか）**: `dimensions=2001` で検査した。

- **N=1**: `CREATE TABLE IF NOT EXISTS` は成功、`CREATE INDEX ... USING hnsw` が
  `54000`「column cannot have more than 2000 dimensions for hnsw index」で失敗する。
  advisory lock は `finally` で正しく解放される（後続の呼び出しが正常に動くことで確認）。
  **DB にはテーブルだけが残り、索引は作られない**——`registerEmbeddingSpace` は
  索引作成の失敗時にテーブルをロールバックしない。
- **N=8（現行実装、ロックあり）**: 8プロセス全員が同じ `54000` で失敗する。
  **テーブルは1個だけ**（複数回の `CREATE TABLE IF NOT EXISTS` 呼び出しが重複作成を
  起こすことはない）、索引は作られない。**ロックは「全員が失敗する」経路でも正しく
  直列化しており、失敗の中に競合状態由来の別種のエラーが混ざることは無かった。**

⚠ **これは advisory lock の正しさの問題ではない**（N=1でも起きる。並行度に依存しない）。
`registerEmbeddingSpace` 冒頭のバリデーション（`Number.isInteger(dimensions) && dimensions > 0`）は
pgvector の hnsw 索引の次元上限（2000）を検査していない、という**既存の・ロックとは独立の
入力検証の抜け**である。指示どおり、ここでは直さず事実と再現手順だけを記録する。

### 見つからなかった形

- 45試行（並行度）× いずれの N でも、部分的に壊れたDB状態（テーブルだけ複数・索引だけ孤立等）は無かった。
- デッドロック（`40P01`）・`tuple concurrently updated` は今回も観測しなかった。
- 63byte切り詰め後の名前衝突は起きなかった（C-1）。
- 別空間の同時登録・schema オプション指定のどちらでも、排他は成立しなくなったりしなかった。

### 新規に確認したこと（ADR 0018 段階1にはなかった情報）

- **N=8/16/32 では、ADR 0018 段階1（N=2/4）に無かった2種の SQLSTATE（`42710`・`42P07`）が
  追加で観測された。** 根の原因は同じ非アトミック性だが、失敗の「形」は2種類ではなく
  4種類に増える（テーブル層2種・索引層2種、という対応関係だと見られるが、これは
  推測であり検証していない）。
- **`dimensions=2000` は pgvector hnsw の有効な境界（成功する）、`2001` から失敗する**
  ことを実測で確認した（ドキュメントの上限値の裏取り）。

### 確かめていないこと

- **N=64 以上は測っていない。** 時間・資源の制約による選択で、上限に当たったからではない。
- **B（空間の組み合わせ）は各1試行のみ**——A のような12試行以上の統計的な確からしさは
  無い。「成立するかどうか」の到達確認に留まる。
- **B の組み合わせに対する変異試験は2パターンのみ**（`openai`/`1536`次元、`schema` 指定）
  ×各6試行。B の他の組み合わせ（`dimensions=1`・`2000`・別空間同時登録など）には
  変異を当てていない。
- **C-1 の衝突は「起きなかった」の1事例のみ。** SHA-256 先頭8byte（32bit）のハッシュ
  衝突を意図的に狙って作り込む検証（理論上は起こりうる）はしていない。
- **この追記のハーネス・生データ（JSONL）はこの PR に含めていない**
  （`packages/postgres/.measure/` は作業ツリー内に置いたがコミットしておらず、
  この追記の外には残らない）。
- **CI（scram認証）環境で同じ測定をしたか**は確認していない（ADR 0017/0018 既知の
  非対称がここでも解消されていない）。
