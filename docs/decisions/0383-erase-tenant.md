# ADR 0383: テナント単位で全表から行を消す `eraseTenant` を足す

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1207](https://github.com/takecchi/mnemora/issues/1207)（クローン miku の
  委譲先が実測して起票、オーナーではない）は、「1つのテナントの消去」を
  `forget` → `purge`（[ADR 0124](./0124-purge-physical-delete.md)）→
  `purgeExpiredEventsForTenant`（[ADR 0115](./0115-event-retention-purge.md)）の
  組み合わせで当てはめた実測から、`recalls`（行そのもの・`query`・`explain`）・
  `recall_usages`・完了した `outbox`・`provenance.speaker`・呼び手が渡した識別子
  （`subject_id`/`external_id`）が消去後も残ることを報告した。[ADR 0375](./0375-purge-scope-widened.md)
  はこのうち「1つの Memory を purge したときに何が消えるか」の射程を広げたが、
  「テナント単位で全表から消す口が無い」こと自体は解決していない——同 ADR
  「これが覆るとしたら」1番は「オーナーが『テナント単位で全表から消す口を新設する』と
  判断したとき」を挙げていた。本 ADR がその判断を実行する。

  **前提の確認（実装前に読んだもの）**: `packages/postgres/migrations/0001_init.sql`
  の全 `CREATE TABLE`/`CHECK`/`REFERENCES` を読み、`tenant_id` 列を持つ表・
  自己参照 FK（`memories.superseded_by_id`/`contested_with_id`）・
  `superseded_by_id`/`contested_with_id` を含む `CHECK` 制約が無いことを確認した
  （後者は「消す前に NULL 化してよい」の根拠——決定4参照）。

- **決めたこと**:

  1. **独立関数 `eraseTenant(ctx, deps, opts)` を `packages/core/src/erase-tenant.ts`
     に置き、公開 export する。**`purgeExpiredEventsForTenant`
     （`packages/core/src/event-retention-purge.ts`、ADR 0115）と同じ置き方——
     **`Runtime` のメソッドは増やさない。`tick()`/`observe()` には配線しない
     （明示呼び出しのみ）。**

     **検討した代替案1: `Runtime.eraseTenant()` メソッドを足す。** ⛔ 採らなかった
     ——`Runtime` のメソッドは「使う側が会話ログを全部積むのをやめられたか」という
     北極星の物差しに沿う通常運用の操作（`observe`/`tick`/`recall`/`forget`/`purge`）
     の集合であり、テナント消去は法的要求・運用上のまれな操作であって、`tick()`
     から自動的に呼ばれることは決して無い——`purgeExpiredEventsForTenant` が既に
     確立した「明示呼び出し専用の独立関数」という形にこの操作も合わせるほうが、
     `Runtime` の表面積を汚さない。

  2. **deps は `{ memoryStore, vectorStore, outboxStore, tenantSettingsStore }`。
     各 port に任意メソッド `eraseTenant?` を足す**
     （`MemoryStore.eraseTenant?`・`VectorStore.eraseTenant?`・`OutboxStore.eraseTenant?`・
     `TenantSettingsStore.eraseTenant?`）。**`EventStore` には足さない**——
     `memory_events` は `MemoryStore.eraseTenant?` の中で直接消す
     （ADR 0115 決定4 が `EventStore` を経由せず `MemoryStore` 側で `memory_events` を
     直接扱ってきたのと同じ形）。

     **MemoryStore が消す表**: `memories`・`observations`・`memory_events`・
     `recalls`・`recall_usages`・`labels`・`memory_labels`・`tenant_activity`・
     `tenant_subject_activity`。**OutboxStore**: `outbox`。**TenantSettingsStore**:
     `tenant_settings`。**VectorStore**: 全 space の `memory_embeddings_*` の
     テナント行。

     **検討した代替案2: 新しい port（`TenantAdminStore` 等）を新設する。** ⛔
     採らなかった——`memories`/`observations`/`memory_events`/`recalls`/
     `recall_usages`/`labels`/`memory_labels`/`tenant_activity`/
     `tenant_subject_activity` はどれも既に `MemoryStore` 実装（Postgres なら
     `PostgresMemoryStore`）が同じ DB 接続で扱っている表であり、新しい port を
     作ると「どの adapter インスタンスが同じ DB を指しているか」を呼び出し側が
     保証する責務が増える。既存4 port（`MemoryStore`/`VectorStore`/`OutboxStore`/
     `TenantSettingsStore`）の組がちょうど「テナントが持ちうる全データ」を覆っている
     ——新設せず、既存の port を拡張するほうが呼び出し側の負担が小さい。

  3. **opts: `{ confirmTenantId: string; limit: number; dryRun?: boolean }`。**
     `opts.confirmTenantId !== ctx.tenantId` または `limit` が正の整数でない場合は、
     **書き込みより前に** `RangeError` を投げる（`markContestedPair?` の
     `first.id === second.id` チェックと同じ「開く前に落とす」位置）。

     **理由**: テナントを丸ごと消す取り消せない操作を、`ctx.tenantId` という
     1箇所の変数だけに頼って実行するのは、呼び出し側の変数取り違え
     （別テナントの `ctx` を渡してしまう等）に対して脆い。`confirmTenantId` を
     別引数として要求し、一致しない限り一切書き込まないことで二重確認にする。

  4. **戻り値**:

     - `{ kind: "store_unsupported"; missing: (...)[] }` —— 4 port のうち1つでも
       `eraseTenant?` を実装していなければ、**何も消さずに**返す。部分的な
       フォールバック（対応している port だけ消す）はしない——「テナントを消した」
       という主張は全表が空になって初めて成立するため。`missing` は port の名前を
       名指しする。

       **任意メソッドにした理由（[ADR 0050](./0050-tenant-event-retention.md) との
       対比）**: ADR 0050 が `getEventRetention`/`setEventRetention` を必須にした
       理由は「口が無い」と「失敗した」が呼び出し側から見分けられないことだった。
       ここでは `store_unsupported` が port を名指しで区別するため、その理由が
       当たらない——任意メソッドのままにできる。**破壊的変更の許可は v1.X.0 で
       出ている**（オーナー回答 ask_human `6911db12`）が、[ADR 0382](./0382-vector-store-delete-across-spaces.md)
       の `deleteAcrossSpaces`（必須メソッド）とは判断を変える——あちらは
       `Runtime.purge`（日常的に呼ばれる操作）の一部として「対応していない
       adapter では別 space の embedding が結局消えない」という限界が常時効くため
       必須にしたが、`eraseTenant`（独立関数、テナント消去というまれな操作）は
       対応していない adapter を壊す理由がここでは弱い、と判断した。

     - `{ kind: "blocked_by_foreign_reference"; count: number }` —— 他テナントの
       行がこのテナントの行を `superseded_by_id`/`contested_with_id` で参照している。
       **他テナントの行は一切書き換えない。`memoryStore.eraseTenant?` 内のバッチは
       ロールバックし、途中まで消えた状態を残さない。**

     - `{ kind: "executed"; dryRun: boolean; deleted: {...}; reachedLimit: boolean }`
       —— 実行した（または `dryRun` でプレビューした）。`reachedLimit === true`
       なら、呼び出し側は同じ `opts` で呼び直すこと——**何度呼んでも安全**
       （既に空になった表は0件を返すだけ）。

     それ以外の失敗（DB 接続断など）は**例外を素通しする**
     （`purgeExpiredEventsForTenant` と同じ）。

  5. **呼び出し順序: `vectorStore` → `outboxStore` → `memoryStore` →
     `tenantSettingsStore`（設定は最後）。**

     **理由**: 途中で処理が中断しても、`tenant_settings` の行が残っている限り
     `getEventRetention` 等の読み手は「まだ設定が生きているテナント」として
     扱い続ける——消去が未完了であることの手がかりが残る。先に設定を消すと、
     未完了のまま `getEventRetention` が既定値（`unset`）へ静かに戻ってしまい、
     消去が終わっていないことに気づきにくくなる。`memoryStore` を最後から2番目に
     したのは、`blocked_by_foreign_reference` を返しうる唯一の port であり、
     それが起きたときに `tenantSettingsStore` へまだ触れていない状態を保つため。

     **⚠ 4つの port は別々の呼び出しであり、分散トランザクションではない。**
     `memoryStore.eraseTenant?` が `blocked_by_foreign_reference` を返すと、
     **その時点で既に完了している `vectorStore`/`outboxStore` の削除は、
     それぞれのトランザクションで既にコミット済みであり、ロールバックされない。**
     次に同じ `opts` で呼び直せば、`vectorStore`/`outboxStore` は既に空なので
     0件で通過し、`memoryStore` だけが（参照が解消されない限り）再び同じ結果を
     返す——副作用が二重に起きることはないが、「他テナントの行は一切書き換えない」
     という保証は `memoryStore` 単体のトランザクションについてだけ厳密に成立する。

  6. **MemoryStore 内は `limit` ごとに1トランザクション。** 子→親の順
     （`memory_labels`・`recall_usages`・`memory_events` → `memories` →
     `observations` → `recalls` → `labels` → `tenant_activity`・
     `tenant_subject_activity`）で処理する。表ごとに、その時点の残り budget
     （`opts.limit` から既に削除した件数を引いたもの）を上限に削除し、
     ある表で budget をちょうど使い切ったら（かつ削除件数が0より大きければ）
     `reachedLimit = true` にしてそこで打ち切る——**保守的な近似**であり、
     実際にはその表にもう行が残っていなくても `true` を返すことがある。
     呼び直しても安全（次の呼び出しは0件で通過するだけ）。

     **検討した代替案3: 表ごとに、実際に「まだ残っているか」を確認してから
     `reachedLimit` を決める。** ⛔ 採らなかった——確認のための追加クエリ
     （`SELECT EXISTS(...)`）を毎回発行するコストと、実装の単純さを天秤にかけ、
     保守的な近似（無駄なもう1回の呼び出しが起きうるだけで、安全性は損なわない）
     を選んだ。

  7. **同じテナント内の自己参照（`memories.superseded_by_id`/`contested_with_id`）
     は、`memories` を削除する前に、そのテナントの行**全体**について
     `UPDATE memories SET superseded_by_id = NULL, contested_with_id = NULL
     WHERE tenant_id = $1 AND (superseded_by_id IS NOT NULL OR contested_with_id
     IS NOT NULL)` で解決する（`limit` には数えない）。**

     **理由**: `limit` で区切ったバッチをまたいで自己参照が残っていると
     （このバッチで消す行を、まだ削除していない別バッチの行が指している場合）、
     `memories(id)` への FK（`ON DELETE` 指定なし＝既定の `NO ACTION`）が違反に
     なる——参照される側（親）を先に消そうとした時点で `23503` になる
     （`erase-tenant-self-ref-batch-boundary.postgres.test.ts` が変異試験で
     実測、下記「確かめたこと」参照）。**CHECK 制約との整合**:
     `migrations/0001_init.sql` を読んで確認した——`superseded_by_id`/
     `contested_with_id` を含む `CHECK` 制約は無い（`CHECK` が掛かっているのは
     `digest_source`・`provenance_kind`・`(provenance_kind, source_observation_id)`・
     `status`・`embedding_status` の5本だけ）ため、`NULL` へ書き換えて構わない
     ——このテナントを丸ごと消す以上、「何に置き換わったか」「どれと矛盾して
     いたか」という参照先の情報を残す意味も無い。

     **検討した代替案4: 複合 FK（`(tenant_id, superseded_by_id)` →
     `(tenant_id, id)`）に変え、`ON DELETE CASCADE` に任せる。** ⛔
     採らなかった——`memories` の主キーは `id` 単体であり、複合 FK にするには
     `(tenant_id, id)` の一意制約を新たに張る必要がある。既存のスキーマを
     広く変更する破壊的な移行になり、本 Issue の射程（消去の口を足す）を
     大きく超える。

     **検討した代替案5: 子（`memory_events` 等）だけを先に消し、`memories` 自身は
     一括の単一 `DELETE`（`WHERE tenant_id = $1`、`LIMIT` なし）に任せる。** ⛔
     採らなかった——`limit` の契約（「1回の呼び出しで削除する上限」）そのものを
     `memories` の段だけ破ることになり、テナントの記憶数が巨大な場合に1回の
     呼び出しが手に負えない時間（ADR 0383「実測」節、索引なしなら90秒/2000行の
     ペースで数十万行に対して延びる）になる。

     **検討した代替案6: 自己参照 FK 違反（`23503`）を捕まえて数える。** ⛔
     事前検査（決定8で採用）に対する代替として検討した——実装としては同程度に
     可能だが、事前検査のほうがエラー処理のコード経路が単純（トランザクションを
     一度も開かずに判定できる）ため、事前検査を選んだ。

  8. **他テナントの行がこのテナントの行を FK で参照している場合の検出は、
     `memories.superseded_by_id`/`contested_with_id` の自己参照 FK に限定する。**
     `memories` を削除する前に、次のクエリで検査する:

     ```sql
     SELECT count(DISTINCT other.id) FROM memories other
     JOIN memories mine ON (other.superseded_by_id = mine.id OR other.contested_with_id = mine.id)
     WHERE mine.tenant_id = $1 AND other.tenant_id <> $1
     ```

     1件でも見つかれば、`memories` の削除トランザクションを一切開かずに
     `blocked_by_foreign_reference` を返す（dryRun でも同じ検査をする——
     「消せない」はプレビューでも分かったほうが有用なため）。

     **⚠ この検出範囲は `memories` の自己参照だけである。** `memory_events.
     memory_id`・`recall_usages.memory_id`・`memories.source_observation_id` も
     理論上は他テナントの行から参照されうる（FK 自体はテナントで絞られていない）
     が、mnemora のどの書き込み経路（`createMemory`/`createObservationWithOutbox`/
     `createRecall` 等）もテナントを跨いだ参照を作らない——通常運用でこの種の
     参照は発生しない。検出範囲をこの1種類に絞ったことは「引き受けた負債」に
     明記する。

  9. **DB には消去の記録を何も残さない。** `memory_events` に `events_purged`
     相当の行を積んだりしない——`memory_events` テーブル自体を消す対象に含めて
     いるため。呼び出し側に返すのは、この関数の戻り値だけである。

     **ADR 0115 決定4「`events_purged` は掃除の対象外」との関係**: 決定4の
     射程は保持期間の掃除（`purgeExpiredEventsForTenant`）だけであり、
     テナント消去はその範囲外——テナント消去は `events_purged`/`purged` の行も
     含めて `memory_events` を丸ごと消す。決定4の本文は書き換えず、この注記を
     ADR 0115 側へ追記する（末尾参照）。

  10. **`recalls` の保持方針（生きているテナントの分）は、この ADR では決めない。**
      [ADR 0290](./0290-activity-seq-read-path-documented-not-implemented.md)
      「これが覆るとしたら」2番が「`recalls` の保持方針」を先の話として挙げている
      ——本 ADR はその問いに答えず、「テナントを丸ごと消す」操作の一部として
      `recalls` も消すだけである。

  11. **索引（`migrations/0027_erase_tenant_fk_indexes.sql`）**:

      - 単一列索引6本: `memory_events(memory_id)`・`recall_usages(memory_id)`・
        `recall_usages(recall_id)`・`memory_labels(memory_id)`・
        `memories(source_observation_id)`・`memories(superseded_by_id)`。
      - **`memories(contested_with_id)` には足さない**——既存の部分索引
        `idx_memories_contested_with`（`migrations/0004_contested_with_index.sql`、
        ADR 0062）が同じ役目を果たしていることを `pg_indexes` で確認した
        （`erase-tenant-fk-indexes.postgres.test.ts` が縛る）。
      - **`CONCURRENTLY` は使わない**——`migrate.ts` は1ファイル=1トランザクション
        で移行を適用しており、`CREATE INDEX CONCURRENTLY` はトランザクション内では
        実行できない（0002/0003/0004/0007/0010 と同じ理由・同じ形、ADR 0059・
        ADR 0062）。
      - 埋め込み空間テーブルの `(memory_id)` 単一列索引を7本目として足す
        （`registerEmbeddingSpace` の DDL に追加。既存の空間には migration の
        `DO` ブロックで遡って作る——`0022_embedding_zero_norm_index.sql` と同じ
        「2つの経路、同じ索引名」の形）。**列挙は `pg_constraint`/`pg_attribute`
        ベース**（Issue #1425 / ADR 0382 決定2 の3条件と同じ）——`0022` の
        `information_schema.columns`（「`embedding` 列が `vector` 型を持つ表」）
        ベースの列挙から変えてある。

      **番号は 0027。** 0026 は別 PR（#933 PR2）が使う予定だが、`migrate.ts` は
      ファイル名の昇順で適用するだけでファイル番号の連番を検査しないため、
      0026 が存在しない状態で 0027 を先に適用しても通ることを実測した
      （`pnpm --filter @mnemora/postgres run migrate` で確認）。

  12. **`packages/postgres` の `deleteAcrossSpaces`（Issue #1425、ADR 0382）と
      `eraseTenant?`（Issue #1207、本 ADR）は、埋め込み空間テーブルの列挙条件を
      共通化する。** `packages/postgres/src/embedding-space-catalog.ts` の
      `listEmbeddingSpaceTables(tx)` に切り出し、`PostgresVectorStore.
      deleteAcrossSpaces`（元は `vector-store.ts` に直接書かれていた）と
      `PostgresVectorStore.eraseTenant` の両方がこの関数を呼ぶ。

      **⚠ SQL（migration の `DO` ブロック）からはこの TypeScript 関数を呼べない**
      （`migrate.ts` は `.sql` ファイルをそのまま実行するだけで、SQL から
      TypeScript の関数を呼ぶ経路が無い）——migration 側は同じ3条件を SQL として
      別途書き写しており、一致は
      `embedding-space-table-enumeration-consistency.postgres.test.ts` が
      実測で検査するだけで、機械的に強制されてはいない（「引き受けた負債」参照）。

- **検討した代替案**:

  （個別の代替案は決定1・2・7・8 の各項目に添えた。ここではそれ以外の全体構造に
  関わる案を挙げる。）

  1. **消去を非同期のバックグラウンドジョブ（outbox 経由）にする。** ⛔
     採らなかった——`eraseTenant` は同期的に呼び出し、その場で結果（`deleted`・
     `reachedLimit`）を返す設計にした。理由: `outbox` 自体が `eraseTenant` の
     削除対象であり、消去ジョブを `outbox` 経由にすると「消去ジョブ自身の行を
     いつ消すか」という循環が生じる。呼び出し側（運用スクリプト）が
     `reachedLimit` を見てループする形のほうが単純である。

- **引き受けた負債**:

  1. **`blocked_by_foreign_reference` の検出は `memories` の自己参照 FK だけに
     限定している（決定8）。** `memory_events.memory_id`・`recall_usages.
     memory_id`・`memories.source_observation_id` が他テナントから参照される
     状態（通常運用では作れないが、直接 SQL を書けば作れる）は検出しない——
     その状態で `eraseTenant` を呼ぶと、検出されない `blocked_by_foreign_reference`
     ではなく、生の FK 違反例外がそのまま素通しされる（契約上は「その他の失敗」
     に分類される）。
  2. **`vectorStore`/`outboxStore` の削除が完了した後に `memoryStore` が
     `blocked_by_foreign_reference` を返すと、`vectorStore`/`outboxStore` 側の
     削除はロールバックされない（決定5）。** 4 port は分散トランザクションでは
     ないため、これは構造的な限界であり、この PR では解消しない。
  3. **`reachedLimit` は保守的な近似であり、実際より多く「まだ残っている」と
     報告することがある（決定6）。** 呼び出し側に無駄なもう1回の呼び出しを
     させるだけで安全性は損なわないが、効率上のわずかな負債ではある。
  4. **埋め込み空間テーブルの列挙条件は、TypeScript と SQL（migration）の
     2箇所に書かれている（決定12）。** 一致は歯が検査するだけで、機械的に
     強制されていない——どちらか一方だけを直すと、歯が検出するまで気づかない。
  5. **`recalls` の保持方針は決めていない（決定10）。**
  6. **`Postgres` 以外の adapter（`@mnemora/testkit` の in-memory fixture・
     `packages/core/src/__tests__/runtime-fakes.ts` の Fake）は、
     `blocked_by_foreign_reference` を一切返さない。** これらの実装は `Map`/
     `Set` の上に成り立っており、外部キー制約もトランザクションの原子性も
     持たないため、常に `{ kind: "executed" }` を返す——`MemoryStore.eraseTenant`
     の戻り値の型としては union が正しいが、Postgres 以外の adapter では
     `blocked_by_foreign_reference` 分岐を実際に運動させる歯は無い。

- **これが覆るとしたら**:

  1. **オーナーが「対応していない adapter を壊してでも `eraseTenant?` を必須に
     する」と判断したとき**（決定4「任意メソッドにした理由」参照）⟹
     `VectorStore.deleteAcrossSpaces`（ADR 0382）と同じ形で必須化する ADR を書く。
  2. **`memory_events.memory_id`・`recall_usages.memory_id`・`memories.
     source_observation_id` が他テナントから参照される具体的な運用上の事故が
     報告されたとき**（負債1）⟹ `blocked_by_foreign_reference` の検出範囲を
     広げる ADR を書く。
  3. **`recalls` の保持方針が別途決まったとき**（ADR 0290「これが覆るとしたら」2番、
     負債5）⟹ `eraseTenant` の `recalls` の扱いも、その方針に合わせて見直す
     必要が生じるかもしれない。
  4. **[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)（PR #1437、
     ADR 0382）の後続作業で `listEmbeddingSpaceTables` の呼び出し側が増えたとき**
     ⟹ SQL（migration）側の列挙条件との一致を、歯ではなく構造的に保証する方法
     （例: migration 自体をこの関数の出力から生成する）を検討する余地が生まれる
     （負債4）。

- **実測**（自分専用の PostgreSQL 17 + pgvector、`packages/postgres` の migration
  を適用済みの使い捨て DB。手順は再現可能——commit していない使い捨てスクリプト/SQL）:

  **手順**: テナント `T` に memories 10万行（うち1%が `superseded_by_id` で他の
  行を指す）・埋め込み8次元の空間・対応する `memory_events`/`recall_usages`/
  `memory_labels` を作り、`EXPLAIN (ANALYZE, BUFFERS)` で子→親の順に削除文を
  測定した。「索引あり」は本 ADR が追加する6本+埋め込みの `(memory_id)` を
  セッション内の一時索引として作った状態、「索引なし」はそれらが無い状態。

  | 測定 | 索引なし | 索引あり |
  |---|---|---|
  | memories 2,000行削除（子表への RI チェック込み） | 90.0秒（うち `memory_events` の FK チェック 54.4秒・埋め込みテーブルの CASCADE チェック 32.6秒） | 0.50秒 |
  | memories 10万行（テナント全件）一括削除 | （測定していない——索引なしでの全件規模は「90.0秒/2,000行」からの外挿で数十分オーダーになると見積もられ、実測は打ち切った） | 22.9秒 |
  | observations 10万行削除 | （同上） | 3.8秒 |
  | `limit` で1万行に区切ったバッチ1回 | — | 約2.2秒 |

  **索引サイズ**（テナント10万行・他テナント20万行の状態、`pg_relation_size`）:
  `memory_events(memory_id)` 12MB（表47MB）・`memories(source_observation_id)`
  9.3MB・`memories(superseded_by_id)` 2.1MB・埋め込みテーブルの `(memory_id)`
  9.3MB・`recall_usages(memory_id)`/`recall_usages(recall_id)` 各0.4〜0.5MB・
  `memory_labels(memory_id)` 0.2MB。

  **書き込み側のコスト**（索引が INSERT を遅くするかどうか。`memory_events` への
  5万行 INSERT、ROLLBACK で反復、3回ずつ）: 索引なし平均 0.96秒（0.98秒/0.90秒/
  1.00秒）・索引あり平均 1.04秒（0.86秒/0.98秒/1.27秒）。**差は約8%で、3回の
  ばらつき（0.86〜1.27秒、約1.5倍の幅）の中に収まる——単一列 B-tree 索引6〜7本
  ぶんの INSERT 側コストは、ノイズと見分けが付かない程度に小さい。**

  **止まる時間（運用上の注意）**: 本 migration の `CREATE INDEX`（`CONCURRENTLY`
  を使わない素の形）は対象テーブルに `ShareLock` を取る——読み取りは止めないが、
  書き込み（`INSERT`/`UPDATE`/`DELETE`）は索引の構築が終わるまで止まる。
  ADR 0059・ADR 0062（[#1423](https://github.com/takecchi/mnemora/issues/1423)
  で訂正済み）が `memories` への同種の索引について実測した「100万行で約2.1秒」
  という形が、この6本の索引にも同様に当てはまると見込まれる（この PR 自身では
  100万行規模の再実測はしていない——`docs/migration-v1.md` の運用の注意として
  この形で明記する）。

- **確かめたこと（赤の証拠・変異試験）**:

  **赤の証拠**（`origin/main` から切った使い捨て worktree に、この PR が新設した
  テストファイルだけを `cp` でコピーして実行した。実装は無い——`@mnemora/core` に
  `eraseTenant` が存在しないため、import の時点で失敗する）:

  | テストファイル | 使い捨て worktree での結果 |
  |---|---|
  | `packages/postgres/src/__tests__/erase-tenant-fk-indexes.postgres.test.ts` | 赤（`eraseTenant` が存在しない・索引が無い） |
  | `packages/postgres/src/__tests__/erase-tenant-all-tenant-tables.postgres.test.ts` | 赤（同上） |
  | `packages/postgres/src/__tests__/erase-tenant-self-ref-batch-boundary.postgres.test.ts` | 赤（同上） |
  | `packages/postgres/src/__tests__/erase-tenant-reobserve-fresh.postgres.test.ts` | 赤（同上） |

  （PR 本文に実際のコマンドと出力を貼る。）

  **変異試験**（`erase-tenant-self-ref-batch-boundary.postgres.test.ts`、この PR の
  実装を一度 green にした状態で、`PostgresMemoryStore.eraseTenantBody` の自己参照
  `NULL` 化の `UPDATE`（決定7）を `if (false && !dryRun)` で無効化した）:

  | 壊し方 | 結果 |
  |---|---|
  | 自己参照 NULL 化を無効化 | 2件とも赤——`error: update or delete on table "memories" violates foreign key constraint "memories_superseded_by_id_fkey"` / `"memories_contested_with_id_fkey"`（SQLSTATE 23503）、狙いどおりの例外 |
  | 復元 | 2件とも緑に戻る（`diff` で元ファイルと完全一致を確認） |

- **確かめていないこと**:

  - 索引あり・100万行規模での `CREATE INDEX` の止まる時間の再実測（ADR 0059・
    ADR 0062 の実測を借用しているだけで、本 PR 自身では測っていない）。
  - `vectorStore`/`outboxStore` の削除が終わった直後に `memoryStore` が
    `blocked_by_foreign_reference` を返す、という決定5の状態を実際に作って
    「その後の呼び直しで副作用が二重に起きない」ことを実測する歯（設計上そう
    なるはずだが、専用の歯は書いていない）。
  - 本番相当のネットワーク越しの Postgres（自分専用インスタンス、ローカル
    ソケット接続での実測である）。
  - `packages/bullmq`・`examples/chat` など、`eraseTenant` を呼ぶ運用側の
    スクリプト・ドライバの実装（本 Issue の範囲外——`packages/core`/
    `packages/postgres` の口を用意するところまでが本 PR の射程）。
