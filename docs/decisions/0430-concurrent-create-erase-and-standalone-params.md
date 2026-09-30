# ADR 0430: 同時呼び出しで落ちる2つの口（trigram store の `create()`、同じテナントへの `eraseTenant`）を直列にし、公開の独立関数の例外からも `params` を落とす

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの依頼を受けた委譲先の担い手が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
決定1の形（ADR 0018 の形を採らず、トランザクション内の xact lock にすること）は、クローンの判断である（オーナーではない）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  3件は、どれも「1つの呼び出しなら通るが、同時に呼ぶと落ちる」または「公開の口だけ `Runtime` と扱いが違う」ものだった。

  **(1) `PostgresTrigramLexicalStore.create()` の同時呼び出し。**【現物】`create()` は probe の中で `CREATE EXTENSION IF NOT EXISTS pg_trgm` を、続けて `ensureTrigramLexicalFunctions`（`CREATE OR REPLACE FUNCTION` の3本）を、lock なしで流していた。
  【実測】（クローンによる）別々の pool から同時に `create()` すると、拡張が無い DB では 2 本で 20 試行中 20 試行、1本が `TrigramLexicalStoreUnavailableError(extension_create_failed)`（中身は 23505、`pg_extension_name_index`）。拡張も関数も在る DB では、1本が素の `Error`（XX000、`tuple concurrently updated`）。
  同じ形の問題は `registerEmbeddingSpace` で [ADR 0018](./0018-register-embedding-space-advisory-lock.md) が、`runMigrations` の拡張作成で [ADR 0331](./0331-extension-creation-shared-advisory-lock.md) の `EXTENSION_LOCK_KEY` が、すでに直している。

  **(2) 同じテナントへの `eraseTenant` の同時呼び出し。**【現物】`PostgresMemoryStore.eraseTenantBody` の `drainById` などは「消せた行数が予算未満なら表は空」とみなす。相手が同じ行を先に消すと0行が返り、行が残っているのに次の表（`memories`）へ進んで 23503（外部キー違反）になる。
  【実測】（クローンによる）`limit: 3` で2つの pool から同時に呼び、全部0になるまで繰り返すと、20呼び出し中4回 reject。

  **(3) 公開の独立関数の例外に `params` が残る。**【現物】`omitParamsFromError` を使うのは `runtime.ts` だけで、ADR 0423 決定6は「`Runtime` の全メソッド」だった。公開の独立関数 `runRecall`・`eraseTenant`・`purgeExpiredEventsForTenant` が投げる例外は、drizzle の `params:` を含んだまま出る。
  【実測】（クローンによる）孤立サロゲート入りの `text` で `runRecall` を直接呼び `recalls` の INSERT を失敗させると、message（1697字）に問いの本文が載る。同じ入力の `Runtime.recall` は `params: (omitted by mnemora, N chars)` になる。

- **決めたこと**:

  1. **`PostgresTrigramLexicalStore.create()` は、probe の `CREATE EXTENSION` と関数のインストールを、1つの `db.transaction` の中で、先頭に `pg_advisory_xact_lock(EXTENSION_LOCK_KEY)` を取ってから流す。**
     - キーは `migrate.ts` の `EXTENSION_LOCK_KEY` をそのまま使う（新しい値は足していない。`export` は元からで、公開 API の入口 `index.ts` には出ていない）。`runMigrations` が拡張を作る段（同じキーを session lock で持つ）とも直列になる。
     - **待ちに mnemora の上限を掛けない。** `lock_timeout` を mnemora が敷くことも、待ち時間切れの新しい例外クラスも足していない。利用者が自分の接続に敷いた `lock_timeout`・`statement_timeout` は、そのまま効く。
     - probe が `ok: false` を返した場合は、値でトランザクションの外へ返し、外で今までと同じ `TrigramLexicalStoreUnavailableError`（`reason`・`cause` 同じ）にする。`extension_create_denied` は `extension_create_denied` のまま。
     - 公開の `probeTrigramLexicalSupport(db)` を単体で呼ぶ経路も、同じ lock の中で流す。【判断】probe も `CREATE EXTENSION` を発行する副作用を持ち、同時に呼べば同じ 23505 になるので、`create()` だけ直して probe を残す理由が無かった。`ensureTrigramLexicalFunctions`（公開）も同じ lock の中で流す（`create()` の中からは、同じセッションの入れ子で lock を重ねて取る）。
  2. **`eraseTenant` の各 port のトランザクションの先頭で、テナントごとに `pg_advisory_xact_lock` を取る。**
     - キーは `deriveAdvisoryLockKey("mnemora:eraseTenant:<tenantId>")`（`advisory-lock.ts` の既存の導出）。別のテナントは待たない。`erase-tenant-lock.ts` に置いた。
     - **対象にした port**【判断】: `PostgresMemoryStore.eraseTenant`（元からトランザクション）、`PostgresVectorStore.eraseTenant`（元からトランザクション）、`PostgresOutboxStore.eraseTenant`（単発の `DELETE` だったので、lock を取るためにトランザクションで包んだ。`dryRun` は包まない）。
       - `memories` の 23503 が実際に出るのは memoryStore だけだが、vector と outbox にも同じ「0行なら空」の読みがある。core の `eraseTenant` は、port が `reachedLimit: false` を返すと次の port へ進み、最後に `tenant_settings` を消す。相手に先に消された分で `deleted < limit` になった port があると、行が残っているのに「設定は最後」の約束（本 ADR の対象 ADR 0383）を破りうる。lock は、後から来た呼び出しが、先の呼び出しのコミット後の状態から数え始めるようにする（`READ COMMITTED` で、lock を取った後の文は新しいスナップショットを見る）。
     - **対象にしなかった port**【判断】: `PostgresTenantSettingsStore.eraseTenant`。`tenant_id` が PK の高々1行で、`reachedLimit` は常に `false`。0行は「相手が消した、または元から無い」で、どちらでも結果は同じ。
     - **直列になる範囲。** port ごとのトランザクションであり、4つの port をまたぐ `eraseTenant` 全体ではない（port の間に別の呼び出しが割り込みうる）。割り込んでも、各 port が lock の下で数え直すので、reject や「空」の読み違いは起きない。3つの port は別々のトランザクションで順に呼ばれ、同時に2本が lock を持つ形は無いので、同じキーを共有してもデッドロックしない。
     - 待ちに mnemora の上限は掛けない（決定1と同じ）。
  3. **公開の独立関数 `runRecall`・`eraseTenant`・`purgeExpiredEventsForTenant` が投げる例外にも `omitParamsFromError` を掛ける。**
     - `Runtime` と重ねて掛かる（`Runtime.recall` → `runRecall`）。【実測】掛け直すと、`omitDrizzleParams` が印の後ろをもう一度「落として」、文字数の数字が印そのものの長さに書き換わることを確かめた（`Runtime` 経由の message が `params: (omitted by mnemora, 34 chars)` になる）。害は数字だけだったが、`omitDrizzleParams` を**べき等**にした（`params:` の後ろが既に `(omitted by mnemora, N chars)` の形ならそのまま返す）。ADR 0363 の outbox の `last_error` も同じ関数を通るが、そこでは二重に掛からない。
     - 例外そのものを返す点（新しい例外を作らない、`kind`・`cause` は変わらない）は ADR 0423 決定6のまま。

- **検討した代替案**:

  1. **決定1で、ADR 0018 の形（`acquireAdvisoryLock`、pool から専用接続を借りる session lock と、専用の待ち時間切れ・取得失敗の例外）にする。** 採らなかった。`create(db)` は drizzle の `Db` しか受け取らず、`Pool` を持たない。また、既存の作法は `lock_timeout` を敷き、待ち時間切れ（`AdvisoryLockTimeoutError` の子）と取得失敗の例外を必ず伴う。これは `create()` に新しい例外を2種足す。クローンの指示は「待ち時間切れを新しい例外として足さない」だった。
  2. **`acquireAdvisoryLock` を `lockTimeoutMs: 0`（`lock_timeout` 無効）で呼ぶ。** 採らなかった。`Pool` を `db.$client` から引く必要があり（`db.$client` は接続を包んだ Proxy で `pool` と同一ではない、`client.ts` の doc）、timeout のファクトリが死んだコードになる。
  3. **決定1で、`create()` 専用の新しいキーを導く。** 採らなかった。`runMigrations` の拡張を作る段と、同じ `CREATE EXTENSION` を巡って並行するので、同じキーで直列にするほうが目的に合う。キーが増えるとデッドロックの検討も増える。
  4. **決定2で、`eraseTenant` 全体（core の関数）に lock を掛ける。** 採らなかった。core は `pg` を知らない（実行時依存は zod だけ、`dependency-boundary.test.ts`）。lock は Postgres の adapter の責務である。
  5. **決定2で、memoryStore だけに lock を掛ける。** 採らなかった。上の対象の判断のとおり、vector・outbox にも同じ読み違いがあり、コストは小さい。
  6. **決定2で、`drainById` などの「予算未満なら空」の読みを、`SELECT count(*)` で確かめ直す形に変える。** 採らなかった。並行する書き込みがあれば、確かめた直後にまた変わる。lock は、消去どうしの競合を根で無くす。
  7. **決定3で、`store` の各メソッドで落とす。** 採らなかった（ADR 0423 の代替案7と同じ理由）。
  8. **決定3で、`omitDrizzleParams` をべき等にせず、二重に掛けないように `Runtime` 側を直す。** 採らなかった。公開の独立関数が直接呼ばれる経路と、`Runtime` の経路が重なる形は、今後も増えうる。関数側をべき等にすると、重ねて掛けても壊れない。

- **引き受けた負債**:

  - **`create()`・probe・`ensureTrigramLexicalFunctions` は、待ちに上限を持たない。** 別のセッションが `EXTENSION_LOCK_KEY` を握ったまま戻らなければ、これらも待ち続ける。`runMigrations`（上限あり、`MigrationLockTimeoutError`）とは違う。利用者は `lock_timeout` か `statement_timeout` を自分の接続に敷いて上限を掛ける（そのときの例外は Postgres の生の例外）。
  - **`create()` の probe と関数のインストールが1つのトランザクションになった。** `CREATE EXTENSION` が失敗するとトランザクションは中断状態になる（25P02）。probe は失敗を値にしてすぐ返すので以降の SQL は流れず、コミットは実質ロールバックになる。関数のインストールが途中で失敗すれば、3本ともロールバックされる（以前は途中までの関数が残った）。
  - **`eraseTenant` の直列化は port ごと。** 全体の一貫性（4つの port が同じ時点のスナップショット）を作るものではない。
  - **lock を取らない自前の adapter は、同時呼び出しで同じ読み違いをする。** core の doc に書いた。適合テストには足していない（本 ADR の歯は `@mnemora/postgres` の中）。
  - **`Runtime` を通らず store を直接呼ぶ呼び出しの message は、依然として落とさない**（ADR 0423 の負債のうち、独立関数の分だけを解消した）。
  - `omitDrizzleParams` のべき等の判定は、`params:` の後ろがちょうど印の形なら通す。利用者の入力が偶然この形の文字列だけのとき、その本文はそのまま残る（印と同じ文字列なので、漏れる情報は無い）。

- **これが覆るとしたら**:

  - `create()` にも待ち時間の上限が要る（運用で、握ったまま戻らない `EXTENSION_LOCK_KEY` が実際に見つかる）ときは、ADR 0018 の形（専用の例外つき）へ寄せる。それはオーナーの判断（公開の例外の追加）になる。
  - `eraseTenant` の全体を1つの一貫した操作にしたいという要求（port をまたぐトランザクション）が出たとき。今の port ごとの形は、ADR 0383 の「分散トランザクションではない」を保ったままである。
  - `EXTENSION_LOCK_KEY` の値を変える理由が生まれたとき（ADR 0331 系の「値を変えるとローリングデプロイ中の互換性が壊れる」が、ここにも当たる）。

- **測ったこと**（【実測】2026-09-30、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に commit して赤を見せ、次の commit で直した）:

  - 決定2: `packages/postgres/src/__tests__/erase-tenant-same-tenant-concurrent.postgres.test.ts`（2つの pool、`limit: 3`、6テナント）。直す前は2回走らせて2回とも赤（reject が6件と8件）。直した後は3回走らせて3回とも緑。
  - 決定3: `packages/core/src/__tests__/standalone-functions-omit-params.test.ts`（4本）。直す前は3本赤（`runRecall`・`eraseTenant`・`purgeExpiredEventsForTenant`）、1本（`Runtime` 経由の重ね掛け）は緑。`omitDrizzleParams` をべき等にする前は、3本の修正だけで `Runtime` 経由の1本が赤になった。
  - 決定1: `packages/postgres/src/__tests__/trigram-create-concurrency.postgres.test.ts`（4本、4つの pool）。(a) 拡張が無い DB（新しい DB を作って migrate 直後、5試行）、(b) 拡張も関数も在る DB（15ラウンド）、(c) 公開の `probeTrigramLexicalSupport` の同時呼び出し、(d) `EXTENSION_LOCK_KEY` を別のセッションが握っている間は `create()` が待ち、放されると成功する。直す前は4本とも赤、直した後は3回走らせて3回とも4本緑。
  - 既存の trigram・erase-tenant・migrate の歯（31ファイル）が緑であること。`trigram-lexical-store-unavailable-cause.test.ts`（偽の `Db`）は、`transaction` と lock の1回分を足した。`trigram-probe-dedicated-schema.postgres.test.ts` の「発行される CREATE EXTENSION の SQL 文字列」は、`pool.query` ではなく `pg.Client.prototype.query` を見る形にした（probe が専用接続で流れるため。SQL 文字列そのものは変わらない）。
  - **測っていないこと**: `runMigrations` が拡張を作る段と `create()` を実際に同時に流す競合（(d) は、キーを共有していることを、握られている間の待ちで確かめただけ）。`create()` の待ちに `lock_timeout` を敷いたときの例外の形。SQL_ASCII の DB での上記の歯（この器では UTF8 のみ）。vector・outbox の lock を縛る歯（変異試験で、`memory-store.ts` の lock を外すと決定2の歯は赤になる。`vector-store.ts` だけ、`outbox-store.ts` だけを外しても緑のままで、この2つの lock は歯で縛れていない。対象にした理由は、上の【判断】のとおり読み違いの構造が同じことだけである）。
