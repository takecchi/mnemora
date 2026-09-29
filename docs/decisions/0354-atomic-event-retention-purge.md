# ADR 0354: 保持期間の読みと `memory_events` の削除を1つの原子的な操作にする（新しい任意メソッド）

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1232](https://github.com/takecchi/mnemora/issues/1232) が実測した:
  `purgeExpiredEventsForTenant`（`packages/core/src/event-retention-purge.ts`）は
  `TenantSettingsStore.getEventRetention`（ADR 0050）で保持期間を読み、その日数から
  `olderThan` を計算してから `MemoryStore.purgeExpiredEvents?`（ADR 0115）を呼ぶ。**読んでから
  消すまでの間に `setEventRetention` が保持期間を変えても（無期限にしても、延ばしても）、
  この呼び出しは読んだときの古い日数で消す**——設定の呼び出しが返った後に、新しい期間なら
  残るはずの行が消えうる。`memory_events` の削除は物理削除であり、戻せない。

  【実測 2026-09-27】自分専用の PostgreSQL 17 + pgvector と testkit の fixture の両方で、
  この振る舞いを確かめた（`getEventRetention` の戻りを門で止め、止めている間に
  `setEventRetention` を呼んで返らせてから、門を外した）。始めの保持期間は30日、イベントは
  40日前と100日前の2件。無期限にしても60日に延ばしても、2件とも消えた——延ばしたのに
  40日前のイベント（60日なら残るはず）まで消える。

  Issue #1232 は、この race を閉じるには新しい仕組みが要ると判断し、4つの案を並べて
  「決めていない」まま委譲へ返した:

  1. 保持期間の読みと削除を同じトランザクションにし、設定の行をロックする
     （`TenantSettingsStore` と `MemoryStore` の別々の口をまたぐので、口の形が変わる）。
  2. `purgeExpiredEvents` の中で保持期間を読み直し、cutoff を作り直す（store が日数を
     知らない、という今の分け方を変える）。
  3. 削除の直前に保持期間を読み直し、変わっていれば打ち切る（読み直しと削除の間の窓は
     小さくなるが、無くならない）。
  4. このままにし、今の振る舞いを doc に書く。

  4は既に着地している——`event-retention-change-during-purge.postgres.test.ts` が
  「今の振る舞い」として2026-09-27に固定した歯である。本 ADR は、1〜3のうち**1を採る形**で、
  実際に race を閉じる。

- **決めたこと**:

  1. **`MemoryStore` に任意メソッド `purgeExpiredEventsByRetention?(ctx, { now, limit, dryRun? })`
     を足す。** 戻り値は `{ kind: "unset" } | { kind: "unlimited" } | { kind: "executed"; result }`
     ——`PurgeExpiredEventsForTenantOutcome` から `store_unsupported` を除いた3種。この口は
     「保持期間を読むことと、実際に削除することを、1つの原子的な操作にする」ことそのものを
     表す——引数に `olderThan`/`retention` を取らない。日数はこの口の**内部**で読む。

  2. **既存の `purgeExpiredEvents?` と `PurgeExpiredEventsOptions`/`PurgeExpiredEventsResult` の
     宣言は変えない。** 「何を消すか」（`kind <> 'events_purged'`・`at < olderThan`・
     `events_purged` イベントの追記・`superseded` 行も対象に含める）という契約は、新しい口も
     そのまま継承する——変えたのは「保持期間をいつ・どこで読むか」だけである。

  3. **`purgeExpiredEventsForTenant` は、今までどおり最初に `tenantSettingsStore.getEventRetention`
     を読み、unset/unlimited なら `memoryStore` に一切触れずに返す**（doc の約束を保つ）。
     `days` のときは、`memoryStore.purgeExpiredEventsByRetention` があればそれへ丸ごと委ねる
     （`now`/`limit`/`dryRun` を渡すだけ——cutoff はこの関数ではもう計算しない）。**無ければ、
     `purgeExpiredEvents?` を実装していても `{ kind: "store_unsupported" }` を返す**——
     旧経路（`purgeExpiredEvents` を直接呼ぶ）への自動フォールバックは無い。

     理由: 自動フォールバックは、Issue #1232 が指摘した race をこの新しい経路でも
     再導入してしまう。「保持期間の読みと削除を同じ操作にできる」という宣言そのものが
     この口を持つことの意味であり、`purgeExpiredEvents?` だけを実装している adapter に対して
     「原子性を装った動作」を黙って提供すると、利用者はまだ race が残っていることに気づけない。

  4. **cutoff の計算（日数→`Date`、`EARLIEST_DATE_MS` への寄せ）を `computeEventRetentionCutoff(now, days)`
     として `packages/core/src/event-retention-purge.ts` に切り出し、`purgeExpiredEventsForTenant`
     がかつて自分で行っていた計算を、`purgeExpiredEventsByRetention?` を実装する各 adapter が
     共有する。** 書き写さない——`@mnemora/postgres` の `PostgresMemoryStore`、`@mnemora/testkit` の
     `InMemoryMemoryStore`、`packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` の
     3実装がすべてこの1つの関数を呼ぶ。

  5. **`PostgresMemoryStore.purgeExpiredEventsByRetention` は、1つのトランザクションの中で
     `SELECT event_retention_days FROM tenant_settings WHERE tenant_id = … FOR SHARE` を読み、
     行が無ければ `unset`、`NULL` なら `unlimited` を返す（消さない）。`days` なら、同じ
     トランザクションの中で今の `purgeExpiredEvents` の本体（対象の SELECT → DELETE →
     `events_purged` の INSERT）を呼ぶ。** `dryRun` の場合も同じ読み方（`FOR SHARE`）にする
     ——書き込みはしないが、原子性の保証自体は dryRun かどうかで変えない。

     `TenantSettingsStore` interface は経由しない——`tenant_settings` テーブルへ直接 SQL を
     発行する。別 adapter（`PostgresTenantSettingsStore`）を経由すると、その呼び出し自体が
     このトランザクションの外に出てしまい、`FOR SHARE` の行ロックが効かなくなる
     （`MemoryStore.purgeExpiredEvents` が `PostgresEventStore` を経由せず `memory_events` へ
     直接 SQL を発行するのと同じ理由の形）。

     `purgeExpiredEvents` の本体は、`SqlExecutor`（`Db` または `db.transaction` のコールバック
     引数のどちらも受け付ける最小 interface。`upsertProposedLabels` などが既に使っている形）を
     取る private メソッド `purgeExpiredEventsBody` へ切り出し、`purgeExpiredEvents`（単独では
     `dryRun` のときトランザクションを開かない、今の挙動のまま）と
     `purgeExpiredEventsByRetention`（常にトランザクションを開き、その中で呼ぶ）の両方が
     共有する。

  6. **`InMemoryMemoryStore`（`@mnemora/testkit`）・`FakeMemoryStore`（`@mnemora/core`）は、
     保持期間の Map を `TenantSettingsStore` 側の実装と共有する。** 前例（ADR 0165 決めたこと13、
     `activitySeq`——`MemoryStore.createRecall` が書き、`TenantSettingsStore.getActivitySeq` が
     読む、同一プロセス内の参照共有）にそのまま倣う:
     - `InMemoryMemoryStore` が `readonly eventRetentionDays = new Map<string, number | null>()`
       を持ち（`activitySeq` と同じ「memoryStore 側が持つ」向き）、
       `InMemoryTenantSettingsStore` のコンストラクタの3番目の任意引数
       （`eventRetentionDaysBacking?`）でこの Map を渡す。省略時は
       `InMemoryTenantSettingsStore` 自身が持つ Map（`ownEventRetentionDays`）にフォールバック
       する——共有が要らない既存の呼び出し（`new InMemoryTenantSettingsStore()` の単独利用）を
       壊さない。
     - `FakeMemoryStore`/`FakeTenantSettingsStore` は、共有の入れ物である `FakeBackingStore` に
       `eventRetentionDays` を足し、両クラスとも同じ `backing` インスタンスを通して読み書きする
       （既存の `activitySeq`/`subjectActivitySeq` と同じ形。`FakeTenantSettingsStore` の
       `backing` は元から省略可能なので、省略時はインスタンス専用の Map にフォールバックする）。
     - `purgeExpiredEventsByRetention` は、この Map を読んでから
       `purgeExpiredEventsSync`（`purgeExpiredEvents` の本体を切り出した、`await` を1つも
       挟まない同期関数）を呼ぶまで、**`await` を1つも挟まない**——「読む」と「消す」の間に
       他の呼び出しの同期区間が割り込む余地を無くす（`InMemoryMemoryStore.createObservationIdempotent`
       の doc コメント「ADR 0054」と同じ形の理由。本物のトランザクションではないが、
       in-memory 実装として原子性を模す唯一の手段）。

  7. **途中で保持期間を短くした場合は、その回から短い期間で消すようになることを受け入れる。**
     Issue #1232 本文が既に指摘しているとおり、短縮の場合は「その回は長い期間で消し、残りは
     次の回で消える」——残り続けることはない。この非対称（延長・無期限化は即座に効くが、
     短縮は次の回まで完全には効かない場合がある）は、`FOR SHARE`（共有ロック、複数の読み手を
     許す）を使う限り避けられない片側であり、[ADR 0115](./0115-event-retention-purge.md) の
     決定1（保持期間を過ぎたイベントは種類を問わず消える）を変えるものではない。

- **検討した代替案**:

  (a) **`purgeExpiredEvents` の中で保持期間を読み直し、cutoff を作り直す**（Issue #1232 が
  挙げた案2）。却下——`purgeExpiredEvents` は「日数を知らない、確定済みの `Date` だけを
  受け取る」という今の設計（単体で決定的にテストできるようにするため）そのものを壊す。また、
  `TenantSettingsStore` は `MemoryStore` とは別の adapter インスタンスであり、
  `purgeExpiredEvents` の型定義だけでは「どの `TenantSettingsStore` を読むか」を表現できない
  ——実質的に本 ADR の決定1（新しい口を足す）と同じ形に帰着する。

  (b) **削除の直前に保持期間を読み直し、変わっていれば打ち切る**（Issue #1232 が挙げた案3）。
  却下——読み直しと削除の間の窓は小さくなるが、無くならない。原子性を「小さくする」のではなく
  「無くす」ことを選んだ——DB のトランザクション分離（Postgres の `FOR SHARE`）がまさにこの
  目的のための道具であり、アプリケーション側で窓を縮める工夫を積む理由が無い。

  (c) **`purgeExpiredEventsByRetention?` を実装していない adapter でも、`purgeExpiredEvents?` へ
  自動的にフォールバックする**（新しい口を「あれば使う、無ければ旧経路」という形にする）。
  却下——決めたこと3の理由のとおり、これは Issue #1232 の race をそのまま残しつつ「直った」
  ように見せる。`store_unsupported` という既存の語彙（ADR 0100 の `WriteAtomicity.store_unsupported`
  と同じ判断）で「この adapter では構造的に縮められない」と正直に示すほうが、
  黙って中途半端な保証を返すより誠実である。

  (d) **`purgeExpiredEvents?` を破壊的に変更し、`olderThan` の代わりに保持期間そのものを
  受け取らせる**。却下——`@mnemora/core` は npm に公開済みであり、既存の第三者 adapter・
  呼び出し側のコードを壊す破壊的変更になる（`docs/autonomy.md`「してはいけないこと」表）。
  任意メソッドを新設するほうが、決めたこと2のとおり既存の契約を無傷で残せる。

- **引き受けた負債**:

  - **`TenantSettingsStore` と `MemoryStore` が別の adapter インスタンスである場合、この口を
    正しく実装できない。** `PostgresMemoryStore.purgeExpiredEventsByRetention` は
    `tenant_settings` テーブルへ直接 SQL を発行する——`TenantSettingsStore` interface を経由
    しない。これは「同じ DB・同じ接続で `MemoryStore` と `TenantSettingsStore` を実装する」
    という参照実装の前提（ADR 0001・ADR 0003）に依存している。自前で2つを別々の DB・別々の
    プロセスに持つ adapter は、この口を安全に実装できない——実装しないという選択（
    `purgeExpiredEventsForTenant` が `store_unsupported` を返す）を取るか、原子性を完全には
    保証できないベストエフォートの実装（自分の `TenantSettingsStore` 相当を読んでから削除する、
    ただし読みと削除の間に他の書き込みが割り込む窓が残ることを引き受ける）を取るかは、
    その adapter の実装者の判断に委ねる。`docs/migration-v1.md` にこの選択肢を明記した。

  - **保持期間を短くした直後の1回は、まだ古い（長い）期間で消える可能性が残る**
    （決めたこと7）。`FOR SHARE` は複数の読み手を許す共有ロックであり、書き手（`setEventRetention`
    の `UPDATE`）を排他するが、既に走っている読み手（別の `purgeExpiredEventsByRetention`
    呼び出し）を待たせない。Issue #1232 本文が既に「短くした場合は残り続けない」ことを
    確認しており、これは新しい負債ではなく、元からの非対称の追認である。

  - **`purgeExpiredEventsByRetention?` の適合テスト（`packages/testkit` の
    `describeMemoryStoreConformance`）は、まだ足していない。** 3実装（Postgres・testkit の
    fixture・core の Fake）を個別に書いたテストで縛っているが、`supportsPurgeExpiredEvents`
    と同じ形の `supportsPurgeExpiredEventsByRetention` フラグを適合スイートへ足す作業は
    本 PR の範囲外に残す——将来、4つ目の `MemoryStore` 実装が現れたときに、この口の契約を
    個別のテストではなく適合スイートで縛る必要が生じたら着手する。

- **歯について**:

  - `packages/postgres/src/__tests__/event-retention-change-during-purge.postgres.test.ts`:
    Issue #1232 本文の実測をそのまま歯にしたもの。2026-09-27時点は「今の（バグの）振る舞い」を
    縛っていた（無期限にしても60日に延ばしても2件とも消える）。本 ADR の実装で、
    「変えた後の期間を守る」——無期限なら1件も消えない、60日なら100日前だけが消え40日前は
    残る——という期待へ反転した。InMemory・Postgres の両方の kit で同じ。
  - `packages/postgres/src/__tests__/purge-expired-events-by-retention-concurrency.postgres.test.ts`
    （新設）: 別の接続が `tenant_settings` 行を未commit の `UPDATE` で保持している間、
    `purgeExpiredEventsByRetention` が実際に行ロック待ちに入ること（`pg_stat_activity.wait_event_type
    = 'Lock'` で確認）、commit 後は最新の値（無期限）を見て1件も消さないことを、
    sleep ではなく障壁で固定して縛る（`archive-decayed-concurrency.postgres.test.ts` と同じ形）。
  - `packages/core/src/__tests__/event-retention-purge.test.ts`: `store_unsupported` が
    `purgeExpiredEventsByRetention?` の有無だけで決まり、`purgeExpiredEvents?` を実装していても
    旧経路へ自動的に落ちないことを縛る（決めたこと3・検討した代替案(c)）。

- **確かめていないこと**:

  - **本物の並行負荷（複数の `purgeExpiredEventsByRetention` 呼び出しが同時に何本も走る場合）
    のスループットへの影響**は測っていない——`FOR SHARE` は読み手同士を排他しないため、
    理論上は問題にならないはずだが、実測はしていない。
  - **`TenantSettingsStore` と `MemoryStore` を別々の DB に持つ、実在する第三者 adapter**での
    実装のしやすさ・原子性の限界は、仮説（「引き受けた負債」1番目）として書いただけで、
    実在する adapter で確かめてはいない。

- **これが覆るとしたら**:

  - **`TenantSettingsStore` と `MemoryStore` を分離した adapter が実際に現れ、`purgeExpiredEventsByRetention?`
    をベストエフォートで実装する必要が生じたとき。** その adapter がどこまでの原子性を
    提供できる（できない）かを、この ADR に追記するか、新しい ADR を起こすかは、そのときの
    実装の形に依存する。
  - **保持期間を短くした直後の1回が古い期間で消える負債（決めたこと7・「引き受けた負債」2番目）
    が、実運用で問題になったとき。** そのときは `SELECT ... FOR UPDATE`（排他ロック、読み手も
    排他する）への変更を検討する——ただし読み手同士も直列化されるため、並行スループットとの
    トレードオフが生じる。
  - **適合テストへ `supportsPurgeExpiredEventsByRetention` を足す4つ目の実装が現れたとき**
    （「引き受けた負債」3番目）。
