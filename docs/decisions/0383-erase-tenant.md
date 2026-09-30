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
       行がこのテナントの行を外部キーで参照している（経路は決定8）。
       **他テナントの行は一切書き換えない。1行も消さずに止め、途中まで消えた状態を
       残さない**（`memoryStore` を最初に呼ぶ——決定5）。

     - `{ kind: "executed"; dryRun: boolean; deleted: {...}; reachedLimit: boolean }`
       —— 実行した（または `dryRun` でプレビューした）。`reachedLimit === true`
       なら、呼び出し側は同じ `opts` で呼び直すこと——**何度呼んでも安全**
       （既に空になった表は0件を返すだけ）。

     それ以外の失敗（DB 接続断など）は**例外を素通しする**
     （`purgeExpiredEventsForTenant` と同じ）。

  5. **呼び出し順序: `memoryStore` → `vectorStore` → `outboxStore` →
     `tenantSettingsStore`（設定は最後）。**

     **`memoryStore` を最初にする理由**: `blocked_by_foreign_reference` を返しうる
     唯一の port であり、止めるときに**ほかの port へまだ1行も触れていない**状態を
     保つため（クローン miku の決定「途中まで消えた状態を残さない」）。
     ⚠ 当初の実装は `vectorStore` → `outboxStore` → `memoryStore` の順で、止まった
     時点でこのテナントの埋め込み・outbox の行が既に消えていた。クローンの決定に
     反するので、この PR の中で順序を入れ替えた（歯:
     `erase-tenant.postgres.test.ts` の「自己参照以外の経路でも止まり、どちらの
     テナントの行も1行も変わらない」、core 側は `erase-tenant.test.ts`）。
     埋め込みの表を `memories` の後に消しても費用は小さい——`memory_embeddings_*`
     の `memory_id` は `ON DELETE CASCADE` で、`migrations/0027` が `(memory_id)`
     索引を足したので CASCADE の検索は索引で引ける（D-full の実測で10万行 1.87秒）。

     **設定を最後にする理由**: 途中で処理が中断しても、`tenant_settings` の行が
     残っている限り `getEventRetention` 等の読み手は「まだ設定が生きているテナント」
     として扱い続ける——消去が未完了であることの手がかりが残る。先に設定を消すと、
     未完了のまま `getEventRetention` が既定値（`unset`）へ静かに戻ってしまい、
     消去が終わっていないことに気づきにくくなる。

     **⚠ 4つの port は別々の呼び出しであり、分散トランザクションではない。**
     `blocked_by_foreign_reference` 以外の理由（接続断など）で途中の port が例外を
     投げた場合、それより前の port の削除はコミット済みのまま残る。次に同じ `opts`
     で呼び直せば、済んだ port は0件で通過する（各 store の `eraseTenant?` は冪等）。

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

  8. **他テナントの行がこのテナントの行を外部キーで参照している場合の検出は、
     外部キーの全経路を `pg_constraint` から数え上げて行う（表名を焼き込まない）。**
     対象は、`current_schema()` の中の単一列の外部キーのうち、参照する側・される側の
     両方に `tenant_id` 列があるもの全部——`memories` の自己参照
     （`superseded_by_id`/`contested_with_id`）・`memories.source_observation_id`・
     `memory_events.memory_id`・`recall_usages.memory_id`/`recall_id`・
     `memory_labels.memory_id`/`label_id`・**埋め込み空間の表の `memory_id`**。
     後から表が増えても（例: #933 PR2 の `memory_relations`）、外部キーを張れば
     自動で入る。経路ごとに次の形で数える（参照される側を `tenant_id` で絞り、
     参照する側を外部キーの列で引く——`migrations/0027` の単一列索引が効く向き）:

     ```sql
     SELECT count(*) FROM <parent> mine JOIN <child> other ON other.<fk> = mine.<pk>
     WHERE mine.tenant_id = $1 AND other.tenant_id <> $1
     ```

     **埋め込み空間の表を入れるのが要点である。** `memory_id` は `ON DELETE CASCADE`
     なので、検査に入れないと他テナントの埋め込みの行が `memories` の削除に巻き込まれて
     黙って消える（クローンの決定「他テナントの行は書き換えない」に反する）。
     ⚠ 当初の実装は `memories` の自己参照だけを検査しており、それ以外の経路では生の
     外部キー違反の例外になり、埋め込みの表では他テナントの行が消えていた。クローンの
     決定に反するので、この PR の中で直した。

     検査は `memories` の削除と**同じトランザクションの先頭で**行い、1件でも
     見つかれば1行も消さずに `blocked_by_foreign_reference` を返す（dryRun でも
     同じ検査をする）。検査と削除の間に他テナントが参照を作って外部キー違反
     （SQLSTATE 23503）になった場合は、トランザクションごとロールバックされたうえで
     数え直して `blocked_by_foreign_reference` を返す——数え直して0件なら他テナント
     由来ではないので、元の例外をそのまま投げる。

     **対象外**: 複数列の外部キー（`tenant_id` を含めればテナントを跨げない）と、
     `tenant_id` を持たない表からの参照（今のスキーマには無い）。

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

      - 単一列索引8本: `memory_events(memory_id)`・`recall_usages(memory_id)`・
        `recall_usages(recall_id)`・`memory_labels(memory_id)`・
        `memories(source_observation_id)`・`memories(superseded_by_id)`・
        `memory_relations(from_memory_id)`・`memory_relations(to_memory_id)`。
      - **`memory_relations` の2本は、実測の報告の後に足した**（クローン miku の判断、
        2026-09-30）。`memory_relations`（migration 0026、Issue #207/#933 PR2、
        ADR 0381）はこの PR の途中で main に入った表で、既存の索引
        `idx_memory_relations_from`/`_to` は `(tenant_id, from_memory_id, kind)`/
        `(tenant_id, to_memory_id, kind)` と `tenant_id` が先頭にある——ほかの6本と同じ
        理由で参照整合性チェックに使えない。`eraseTenant` だけでなく `purge` も
        `memories` を消すので、索引が無いと `memories` を1行消すたびに
        `memory_relations` の全行（全テナント分）を走査することになり、この ADR が狙う
        大きなテナントの削除でそのまま重さになる。
        **検査がこの索引を使うことの歯**:
        `erase-tenant-fk-index-used-by-ri-check.postgres.test.ts`。参照整合性チェックは
        トリガの中の問い合わせで、`EXPLAIN ANALYZE` はその計画を見せない（トリガの時間と
        回数だけ）。代わりに、`enable_seqscan = off` の専用の接続で `memories` の行を1件
        消し、`pg_stat_user_indexes.idx_scan` が2本とも増えることを見る
        （`pg_stat_force_next_flush()` の後に読む）。`enable_seqscan = off` にするのは、
        テストの表が小さく、そのままではプランナーが全件走査を選ぶため——この歯が縛るのは
        「検査の問い合わせがこの索引で引ける」ことである。2本を migration から抜く変異で
        赤になることを確かめた。
      - `eraseTenant` は `memory_relations` の行も消す（`MemoryStore.eraseTenant?` の
        中で、`memories` より先に）。`purgeMemory` がこの表に触れない決定（ADR 0381
        決定10）は変えていない。
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

  1. **`blocked_by_foreign_reference` の検査は、呼び出しごとに外部キーの経路の
     数だけ問い合わせを打つ（決定8）。** 経路ごとに、このテナントの行を
     `tenant_id` で絞って外部キーの列の索引で引くので、今の実測規模では小さいが、
     バッチ（`limit`）ごとに毎回走る。
  2. **`blocked_by_foreign_reference` 以外の理由で途中の port が例外を投げると、
     それより前の port の削除はコミット済みのまま残る（決定5）。** 4 port は
     分散トランザクションではないため、これは構造的な限界である。呼び直せば
     済んだ port は0件で通過する。
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
  2. **テナントを跨いだ参照をスキーマで禁じる（外部キーを `(tenant_id, id)` の
     複合にする）と決めたとき** ⟹ 決定8の検査は要らなくなる。複合キーにする案は
     実測の報告の段階でクローンが採らなかった（migration が大きく、止まる時間も
     長いため）。
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
  測定した。「索引あり」は本 ADR が当初追加した6本+埋め込みの `(memory_id)` を
  セッション内の一時索引として作った状態、「索引なし」はそれらが無い状態。

  | 測定                                             | 索引なし                                                                                                                   | 索引あり |
  | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------- |
  | memories 2,000行削除（子表への RI チェック込み） | 90.0秒（うち `memory_events` の FK チェック 54.4秒・埋め込みテーブルの CASCADE チェック 32.6秒）                           | 0.50秒   |
  | memories 10万行（テナント全件）一括削除          | （測定していない——索引なしでの全件規模は「90.0秒/2,000行」からの外挿で数十分オーダーになると見積もられ、実測は打ち切った） | 22.9秒   |
  | observations 10万行削除                          | （同上）                                                                                                                   | 3.8秒    |
  | `limit` で1万行に区切ったバッチ1回               | —                                                                                                                          | 約2.2秒  |

  **索引サイズ**（テナント10万行・他テナント20万行の状態、`pg_relation_size`）:
  `memory_events(memory_id)` 12MB（表47MB）・`memories(source_observation_id)`
  9.3MB・`memories(superseded_by_id)` 2.1MB・埋め込みテーブルの `(memory_id)`
  9.3MB・`recall_usages(memory_id)`/`recall_usages(recall_id)` 各0.4〜0.5MB・
  `memory_labels(memory_id)` 0.2MB。

  **書き込み側のコスト**（索引が INSERT を遅くするかどうか）: 同じ Postgres・同じ
  データで、`memory_events` へ他テナントの `memories` を元に5万行を INSERT し
  `ROLLBACK` する。索引なしの場合と、同じトランザクションの中で単一列の索引7本を
  `CREATE INDEX` してから同じ INSERT をする場合を、交互に3回ずつ測った（`psql` の
  `\timing`）。索引なし 0.879秒/0.899秒/0.930秒（平均 0.90秒）・索引あり
  0.922秒/0.976秒/0.935秒（平均 0.94秒）。**差は約4〜5%で、3回のばらつき
  （索引なしの中だけで約6%の幅）に近い——INSERT 側の費用は小さい。**

  **止まる時間（運用上の注意）**: 本 migration の `CREATE INDEX`（`CONCURRENTLY`
  を使わない素の形）は対象テーブルに `ShareLock` を取る——読み取りは止めないが、
  書き込み（`INSERT`/`UPDATE`/`DELETE`）は索引の構築が終わるまで止まる。
  ADR 0059・ADR 0062（[#1423](https://github.com/takecchi/mnemora/issues/1423)
  で訂正済み）が `memories` への同種の索引について実測した「100万行で約2.1秒」
  という形が、この8本の索引にも同様に当てはまると見込まれる（この PR 自身では
  100万行規模の再実測はしていない——`docs/migration-v1.md` の運用の注意として
  この形で明記する）。

- **確かめたこと（赤の証拠・変異試験）**:

  **赤の証拠**（`origin/main` から切った使い捨て worktree に、この PR が新設した
  テストファイルだけを `cp` でコピーして実行した。実装は無い——`@mnemora/core` に
  `eraseTenant` が存在しないため、import の時点で失敗する）:

  | テストファイル                                                                          | 使い捨て worktree での結果                   |
  | --------------------------------------------------------------------------------------- | -------------------------------------------- |
  | `packages/postgres/src/__tests__/erase-tenant-fk-indexes.postgres.test.ts`              | 赤（`eraseTenant` が存在しない・索引が無い） |
  | `packages/postgres/src/__tests__/erase-tenant-all-tenant-tables.postgres.test.ts`       | 赤（同上）                                   |
  | `packages/postgres/src/__tests__/erase-tenant-self-ref-batch-boundary.postgres.test.ts` | 赤（同上）                                   |
  | `packages/postgres/src/__tests__/erase-tenant-reobserve-fresh.postgres.test.ts`         | 赤（同上）                                   |

  （PR 本文に実際のコマンドと出力を貼る。）

  **変異試験**（`erase-tenant-self-ref-batch-boundary.postgres.test.ts`、この PR の
  実装を一度 green にした状態で、`PostgresMemoryStore.eraseTenantBody` の自己参照
  `NULL` 化の `UPDATE`（決定7）を `if (false && !dryRun)` で無効化した）:

  | 壊し方                   | 結果                                                                                                                                                                                                |
  | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 自己参照 NULL 化を無効化 | 2件とも赤——`error: update or delete on table "memories" violates foreign key constraint "memories_superseded_by_id_fkey"` / `"memories_contested_with_id_fkey"`（SQLSTATE 23503）、狙いどおりの例外 |
  | 復元                     | 2件とも緑に戻る（`diff` で元ファイルと完全一致を確認）                                                                                                                                              |

  **変異試験（2回目、別の worktree `/tmp/mgr-f6cb1d7b-red` で、枝の実装に1か所ずつ
  変異を入れ、対照（変異なし）が緑であることを確かめたうえで）**:

  | 変異                                                                 | 歯                                                      | 結果                                                                                                                                                                                                                                                                                                                                                               |
  | -------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | M1: 自己参照の NULL 化を抜く                                         | `erase-tenant-self-ref-batch-boundary.postgres.test.ts` | 2件とも赤（SQLSTATE 23503）                                                                                                                                                                                                                                                                                                                                        |
  | M2: `tenant_subject_activity` の削除を抜く                           | `erase-tenant-all-tenant-tables.postgres.test.ts`       | 赤（消し切った後に行が残る表を名指し）                                                                                                                                                                                                                                                                                                                             |
  | M3: `tenant_settings` を消さない                                     | `erase-tenant-reobserve-fresh.postgres.test.ts`         | 赤（`getEventRetention` が `unset` ではなく `unlimited`）                                                                                                                                                                                                                                                                                                          |
  | M4: migration から `idx_memory_events_memory_id` を抜く              | `erase-tenant-fk-indexes.postgres.test.ts`              | 赤                                                                                                                                                                                                                                                                                                                                                                 |
  | M5: 消す間 `memories` 全体を `SHARE ROW EXCLUSIVE` でロックし2秒待つ | `erase-tenant-concurrent-other-tenant.postgres.test.ts` | 赤（別テナントへの INSERT が1秒以内に終わらない）。⚠ 当初の形（閾値5秒・消去が途中かを確かめない）では、この変異で緑のままだった——事前検査の `SELECT` が取る `AccessShareLock` を「消去中」と取り違えていた。`AccessShareLock` より強いロックを持つまで待ち、閾値を1秒にし、INSERT が終わった時点で消去がまだ途中であることを確かめる形に直した（対照は3回とも緑） |
  | M6: `0027` から `memory_relations` の単一列索引2本を抜く | `erase-tenant-fk-indexes.postgres.test.ts`・`erase-tenant-fk-index-used-by-ri-check.postgres.test.ts` | 2本とも赤（索引が無い／`idx_scan` の行が返らない） |
  | 直す前の実装（`4fbaf2a`）に、決定8の新しい歯だけを持ち込む           | `erase-tenant.postgres.test.ts`（自己参照以外の経路）   | 赤（`blocked_by_foreign_reference` ではなく、`memory_events_memory_id_fkey` の外部キー違反の例外）                                                                                                                                                                                                                                                                 |

- **確かめていないこと**:

  - 索引あり・100万行規模での `CREATE INDEX` の止まる時間の再実測（ADR 0059・
    ADR 0062 の実測を借用しているだけで、本 PR 自身では測っていない）。
  - 検査と削除の間に他テナントが参照を作って外部キー違反になる競合（決定8の
    数え直しの経路）を、実際に割り込ませて起こす歯（経路はコードにあるが、
    専用の歯は書いていない）。
  - 本番相当のネットワーク越しの Postgres（自分専用インスタンス、ローカル
    ソケット接続での実測である）。
  - `packages/bullmq`・`examples/chat` など、`eraseTenant` を呼ぶ運用側の
    スクリプト・ドライバの実装（本 Issue の範囲外——`packages/core`/
    `packages/postgres` の口を用意するところまでが本 PR の射程）。

## 追記（2026-09-30）: `dryRun` の `deleted.vectorStore` と本番の値が食い違う——CASCADE による

⛔ 上の本文は書き換えていない。決定5（呼び出し順序）も変えていない。

**何が起きるか。**`eraseTenant` の戻り値の `deleted.vectorStore` は、`dryRun: true` では `26` のような実数を返すのに、本番では `0` を返す。**行は正しく消えている。**原因は決定5の順序にある: `memoryStore` を先に消すと、`memories` の行が消えた時点で `memory_embeddings_<space>.memory_id`（`ON DELETE CASCADE`）が埋め込みの行を一緒に消す。`vectorStore.eraseTenant?` が呼ばれる頃、そのテナントの埋め込みはもう無く、数えるものが残っていない。`dryRun` は何も消さないので、消える予定の行をそのまま数える。

**確かめたこと（2026-09-30、自分専用の PostgreSQL 17 + pgvector。`migrate` で全 migration を適用した DB）**:

- `eraseTenant` の歯が使う種まき（`erase-tenant-test-helpers.ts` の `seedAllTablesForTenant`）で1テナントに行を作り、`memories` 14行・埋め込みの表14行の状態から `eraseTenant` を呼んだ。`dryRun: true` は `{ vectorStore: 14, outboxStore: 32, memoryStore: 73, tenantSettingsStore: 1 }` を返し、呼んだ後も `memories` 14行・埋め込み14行のまま。続けて本番を呼ぶと `{ vectorStore: 0, outboxStore: 32, memoryStore: 73, tenantSettingsStore: 1 }` を返し、`memories` 0行・埋め込み0行になった。**実数が `0` になるのは `vectorStore` の1欄だけで、行は消えている。**
- `pg_constraint` で、埋め込みの表から `memories` への外部キーの `confdeltype` が `c`（CASCADE）であることを確かめた。⚠ **この外部キーは `migrations/*.sql` ではなく、`registerEmbeddingSpace`（`packages/postgres/src/vector-space.ts`）が空間ごとの表を作るときの DDL に在る**——埋め込みの表は migration が作らない（`migrations/0022` の冒頭の注と同じ）。
- **確かめていないこと**: `limit` で `memoryStore` のバッチが途中で止まった（`reachedLimit: true`）回の `deleted.vectorStore` の値（`memoryStore` が消した分の埋め込みは CASCADE で消え、残った分の `memories` にはまだ埋め込みが在るので、`vectorStore` 側は `memoryStore` が触れなかった行だけを数えるはずだが、打っていない）。`VectorStore` の別実装（`@mnemora/postgres` 以外）で CASCADE が無い場合の値。

**採らなかった案**: `vectorStore` を先に呼んで件数を実数にする——決定5の不変条件（止まるときに他の port へ1行も触れていない状態を保つ）を壊す。CASCADE で消えた分を `memoryStore` 側で数えて足す——連鎖して消える行数を別に数える手段が要る。今はその必要を認めていない（検討しただけで、試していない）。**食い違いは戻り値の型を変えずに文書で説明する**に留めた。

**消去の完了は、戻り値の件数ではなく表を数えて確かめること。**同じ説明を `packages/core/src/erase-tenant.ts` の doc コメントと `docs/memory-model.md` §9 の追記に置いた。

## 追記2（2026-09-30）: そのテナントへの書き込みを止めてから呼ぶ／`deleted` が全部 `0` になるまで呼び直す

⛔ 上の本文と上の追記は書き換えていない。決定も変えていない（文書の追記だけ）。

**同じテナントへ書き込みながら `eraseTenant` を呼ぶと、行が残りうる。**消している途中に `observe()`・`tick()` などが書いた行は、その回では消えない。⟹ **そのテナントへの書き込みを止めてから呼ぶ。**本文の「`reachedLimit === true` なら呼び直す」は、`limit` で区切られた分の話であり、`reachedLimit === false` が「空になった」を保証するものではない（書き込みが止まっていなければ）。⟹ **書き込みを止めたうえで、`deleted` の4欄が全部 `0` で返る回が出るまで呼び直す。**その後に表を数えて確かめる（上の追記のとおり、`deleted.vectorStore` は CASCADE で本番では `0` になりうるので、`deleted` の件数だけでは「消えた」を言えない）。

どの表に何が残りうるかは、`packages/core/src/erase-tenant.ts` の doc コメントと [`docs/memory-model.md`](../memory-model.md) §9 に書いた。

**確かめていないこと**: 書き込みを実際に割り込ませて、残る行を起こしてはいない。上の説明は `@mnemora/postgres` の実装（表ごとに「対象の id を先に選んでその id だけを消す」文）を読んだ推論である。`embed` の書き込みが `memories` の削除の後にどうなるか（外部キーで失敗するはず）も確かめていない。

## 追記（2026-09-30）: 約束と実装が違っていたので、実装を約束に合わせた——`limit` で止まった回は、後ろの port を呼ばない

⛔ 上の本文と、直前の追記（`deleted.vectorStore`）は書き換えていない。決定5（呼び出し順序）も変えていない。

**何が違っていたか。**決定5と `eraseTenant` の doc は「設定（`tenantSettingsStore`）は最後にする——途中で処理が中断しても、まだ『テナントが存在する』ことの手がかりとして残る」と約束していた。だが実装は、`memoryStore.eraseTenant?` が `reachedLimit: true` を返しても、続けて `vectorStore`・`outboxStore`・`tenantSettingsStore` を呼んでいた。Postgres で `limit: 10` を渡して1回呼ぶと、`memories` 13件のうち消えたのは一部なのに、`tenant_settings` は 1 → 0、埋め込みは 13 → 3、outbox は 31 → 21 になった（別の担当の実測）。`memories` が残っているのに設定が無い、という「途中で止まった」ことの手がかりを消す状態である。**約束が正しく、実装が約束に届いていなかった。**

**決めたこと（実装を約束に合わせた）。**

1. **いずれかの port が `reachedLimit: true` を返したら、そこで打ち切り、後ろの port は呼ばずに `reachedLimit: true` で返す。**順序は `memoryStore` → `vectorStore` → `outboxStore` → `tenantSettingsStore` のまま。`vectorStore`・`outboxStore` が `reachedLimit` を返したときも同じ（前の port が消し切っていないときに設定を消さない、という約束は `memoryStore` に限らないため）。設定が消えるのは、前の3つが消し切った回だけ——つまり `reachedLimit: false` で返る回に限られる。
2. **呼ばなかった port の `deleted` は `0`。**型（`deleted` は「この呼び出しでその port が実際に消した行数」）どおり、呼ばなかった port は1行も消していない。採らなかった案: 欄を欠落・`undefined` にする（戻り値の型が割れ、呼び手が4欄を足し算するたびに分岐が要る）、前の回の値を持ち越す（`eraseTenant` は状態を持たない）。
3. **`dryRun` も同じ経路を通る。**`memoryStore` が `reachedLimit` を返したら、後ろの port は数えず `0` で返す。プレビューは「本番の1回目がどういう形で返るか」を写すもので、`dryRun` だけ全 port を数えると、プレビューの形と実際に起きる形が割れる。採らなかった案: `dryRun` だけは何も消さないので全 port を数える（実数は見えるが、上の理由で採らなかった。`limit` で止まらない `dryRun` は、これまでどおり全 port を数える）。
4. **`reachedLimit` は保守的な近似**（本文の `reachedLimit` の決め方の節）のままなので、`deleted` が `limit` ちょうどで消し切れていた port でも、その回は後ろの port へ進まず、次の回で進む。呼び直しの回数が高々1回増えるだけで、消え残りは出ない。

**確かめたこと（2026-09-30、自分専用の PostgreSQL 17 + pgvector。UTF8（`C.UTF-8`）と SQL_ASCII（`C`）の2つ。`migrate` で全 migration を適用した DB）**:

- 直す前の実装に、`limit` で止まった回に設定・outbox・埋め込みが残ることを見る歯を当てた（core の fake の store と Postgres の両方）。core は5本中5本、Postgres は2本中2本が赤（Postgres の1本目は `tenant_settings` が 1 → 0、2本目の `dryRun` は `deleted.vectorStore` が 0 でなく 10）。
- 直した後の実装で、上と同じ形の 1テナント（`memories` 13・埋め込み13・outbox 31・`tenant_settings` 1）に `limit: 10` を 11 回呼んだ。1〜7回目は `memoryStore` の 10 だけが `deleted` に入り、`tenant_settings` は 1 のまま。4回目に `memories` が 9 に、5回目に 0 になり、埋め込みも同じ回に 9 → 0（CASCADE。どの欄にも数えられない）。8〜10回目に outbox が 31 → 21 → 11 → 1、11回目に outbox の最後の 1 と `tenant_settings` の 1 が消えて `reachedLimit: false`。全 11 回で `deleted.vectorStore` は `0` だった。呼び直せば最後まで消え、`tenant_settings` が消えるのは最後の回だけである。

**直前の追記の「確かめていないこと」の解決。**直前の追記は「`limit` で `memoryStore` が途中で止まった回の `deleted.vectorStore` の値」を打っていなかった。これは、`vectorStore` を**呼ばない**ので `0` である（`dryRun` でも `0`）。`memories` を消し切る回では、CASCADE で埋め込みも消えているので `vectorStore` には数えるものが残らず、やはり `0` になる。よって `@mnemora/postgres` では、本番の `deleted.vectorStore` は（並行する書き込みが無い限り）つねに `0` である。並行する書き込みが有るときの値は打っていない。

**`deleted.memoryStore` の数え方の訂正（doc）。**`packages/core/src/erase-tenant.ts` の doc に「`deleted.memoryStore` も `memories` 側の行数を数えるだけである」とあったのは誤りだった（直前の追記の `memoryStore: 73` が、`memories` 14 行より大きいことに現れている）。実装（`PostgresMemoryStore` の `eraseTenantBody`）は 10 表（`memory_labels`・`recall_usages`・`memory_events`・`memory_relations`・`memories`・`observations`・`recalls`・`labels`・`tenant_activity`・`tenant_subject_activity`）を消し、`deleted.memoryStore` はその全表の合計である。`MemoryStore.eraseTenant` の doc の「対象8表」も、`memory_relations` を欠いた一覧だったので 10 表に直した。

**報告に留めたこと。**`@mnemora/testkit` の `InMemoryMemoryStore.eraseTenant` は Postgres と同じ 10 表の合計を数える（`tenant_subject_activity` だけは、テナントあたり 1 行と単純化している。Postgres は subject ごとの行数）。ただし `InMemoryVectorStore` は `memories` の削除で埋め込みを巻き込まない（Postgres の CASCADE に当たる動きが無い）ので、インメモリの組では本番でも `deleted.vectorStore` が実数になる。conformance の範囲に関わるので、本 PR では揃えていない。

**引き受けた負債。**呼び直しが増える: `limit` が小さいと、`vectorStore`・`outboxStore` の削除は前の port が消し切った後の回に回るので、全体の呼び出し回数は前より増える（上の 11 回の実測）。設定が消えるまでの間、テナントは「消去の途中」として見え続ける（それが約束）。

**これが覆るとしたら。**`eraseTenant` を呼ぶ運用側が「1回の呼び出しで全 port を進める」ことを前提にしていると分かったとき。ただし `eraseTenant` は未リリースの 1.2.0 で入った関数で、その前提は約束（本文）が最初から否定していた。

**区分。**`eraseTenant` は `v1.1.0` に入っていない（未リリースの `[1.2.0]` 節で入った関数）ので、`v1.1.0` から上げる利用者にとって変わる振る舞いは無い。よって `docs/migration-v1.md` の破壊的変更の一覧には載せず、CHANGELOG は既存の `eraseTenant` の項に書き足した。


## 追記（2026-09-30）: 同じテナントへの同時呼び出しは直列になる（ADR 0430 決定2）

⛔ 上の本文と、これまでの追記は書き換えていない。

**何が起きていたか。**各 port の `eraseTenant` は、消せた行数が予算（`limit`）未満なら「その表は空になった」と読んでいた。同じテナントへ別の呼び出しが同時に走ると、相手が先に消した行は自分の `DELETE` に数えられず、行が残っているのに `memories` へ進み、23503（外部キー違反）で reject した。実測は [ADR 0430](./0430-concurrent-create-erase-and-standalone-params.md)。

**決めたこと。**`@mnemora/postgres` の `memoryStore`・`vectorStore`・`outboxStore` の `eraseTenant` は、トランザクションの先頭でテナントごとの `pg_advisory_xact_lock` を取る。同じテナントへの同時呼び出しは、その port のトランザクションごとに直列になる。別のテナントは待たない。`tenantSettingsStore` は対象にしなかった（理由は ADR 0430）。`packages/core/src/erase-tenant.ts` の doc にも同じことを書いた。

**残ること。**直列になるのは port ごとであり、`eraseTenant` 全体（4つの port をまたぐ呼び出し）ではない。
