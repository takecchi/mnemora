# ADR 0404: 古い `recalls` と完了済みの `outbox` 行を消す口 `purgeExpiredRecalls?` / `purgeCompletedJobs?` を足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「決めたこと」の各項の末尾と、下の「オーナーに聞く事柄」にまとめてある。**

- **文脈**:

  `eraseTenant`（[ADR 0383](./0383-erase-tenant.md)）以外に、`recalls` と `outbox` の行を消す経路が無い。
  どちらも生きているテナントで行が増え続ける——`recalls` は recall 1回ごとに1行、`outbox` は
  ジョブ1件ごとに1行で、完了しても消えない。[ADR 0290](./0290-activity-seq-read-path-documented-not-implemented.md)
  の 2026-09-30 追記は「`recalls` の保持方針は決めていない」、[ADR 0357](./0357-outbox-reclaim-requeues-to-tail.md)
  の負債1は「outbox 行は無限に蓄積する」と書いていた。`docs/memory-model.md` §9「forget() と purge() を分ける」の表も
  「完了した行を消す経路も保持期間も無い」と書いている。`memory_events` にだけは
  `purgeExpiredEvents?`（[ADR 0115](./0115-event-retention-purge.md)）がある。

  本 ADR は、その `purgeExpiredEvents?` と同じ形の任意メソッドを2つ足す。**何日残すかは決めない**
  ——口を用意するだけである。

- **決めたこと**:

  1. **口を2つ足す。どちらも任意メソッド（`?`）。**
     - `MemoryStore.purgeExpiredRecalls?(ctx, { olderThan, limit, dryRun? })`
       → `{ purged, purgedUsages, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun }`
       （`createRecall` が `MemoryStore` に在るため、こちらに置く）
     - `OutboxStore.purgeCompletedJobs?(ctx, { olderThan, limit, dryRun? })`
       → `{ purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun }`

     任意にした理由は `purgeExpiredEvents?` と同じ（`@mnemora/core` は npm 公開済みで、必須メソッドを
     足すと第三者 adapter を壊す）。`limit` を必須にしたのも同じ（取り消せない削除の上限を
     `packages/core` が勝手に決めない）。

  2. **保持期間（`olderThan`）は呼び出し側が必ず渡す。既定値を持たせない。**
     **「何日残すか」の既定値はオーナーに聞く事柄であり、本 ADR は決めていない。**
     `tenant_settings` に保持日数の列を足す案（`event_retention_days` のような）も採っていない——
     設定の置き場と既定値を同時に決めることになるため。

  3. **消すのは次の2つだけ。**
     - `recalls`: `created_at < olderThan`（境界 `=` は残す。`purgeExpiredEvents` と同じ）。古い順。
     - `outbox`: `completed_at IS NOT NULL AND completed_at < olderThan`。古い順。

     **`outbox` の完了していない行——claim 中（リース内でもリース切れでも）・未処理・`failed_at` が付いた行——は、
     どれだけ古くても決して消さない。**歯: `outbox-store-conformance.ts` の「完了していない行を、どれだけ古くても
     決して消さない（failed・claim 中・未処理）」（`failed_at = 2000-01-01` の行を含む）。実装は述語に
     `completed_at IS NOT NULL` を持ち、`complete` と `fail` が互いに排他な終端である（Issue #826）ので、
     `failed_at` の行に `completed_at` は付かない。

     **`failed` は完了ではないので対象外にした。失敗行をいつ・どう消すか（残して調べるのか、
     期限で消すのか、再投入するのか）はオーナーの判断であり、本 ADR は決めていない。**
     ADR 0357 負債1の「止まり続ける job」も、この口では消えない。

  4. **`recalls` を消すときは、同じトランザクションで先に `recall_usages` を消す。**
     `recall_usages.recall_id REFERENCES recalls(id)` には `ON DELETE` の指定が無い（`0001_init.sql`。
     【実測】`pg_constraint` で `recalls` を参照する FK が `recall_usages_recall_id_fkey` の1本だけで、
     `outbox` を参照する FK は無いことを確かめた）。`eraseTenant` の順（`recall_usages` → `recalls`）が前例。
     Postgres 実装は、対象の `recalls` を先に確定し（`created_at, id` 順に `limit + 1` 件、削除するときは
     `FOR UPDATE`）、その id の子 → 親の順に消す。**`limit` は `recalls` の行数で数え**、一緒に消えた
     `recall_usages` の行数は `purgedUsages` に別に返す。並行の `recordUsage`（外部キー検査が親の行ロックを
     取る）が割り込んだ場合は、そちらが待たされ、こちらの commit 後に外部キー違反になる。

     **帰結（呼び出し側が知るべきこと）**:
     - **消えた recall の使用記録（どの記憶が使われたと報告されたか）も消える。**
     - **消した後に古い `recallId` で `recordUsage` すると例外になる**——Postgres は外部キー違反、
       `InMemoryMemoryStore` と `FakeMemoryStore` は `recall not found`（`recall_usages.recall_id → recalls(id)`
       の相当の検査。ADR 0047）。ただし `memoryIds` が空配列なら、どの実装も検査より前に空を返す。
       `observe({ kind: "memory_usage" })` が古い recallId で来ると、この例外になりうる。
       歯: 「消した recall へは、もう recordUsage できない」。
     - `memory_events.meta.note` などに `recallId` の文字列が載っていても、外部キーではないので**残る**。
       残った文字列が指す行はもう無い。
     - **Memory 本体は消えない**（歯: 「Memory 本体・新しい recall の使用記録は残す」）。

  5. **`recalls.query` の中身を purge で消すかどうか（約束の範囲）には触れていない。**
     `purgeMemory`（ADR 0375）は `recalls.query` を「残る」側に置いたままである。本 ADR の口は行ごと消すだけで、
     「どの範囲を消すと約束するか」は決めていない——**オーナーに聞く事柄。**

  6. **`memory_events` に監査行（`events_purged` のような集計行）を積まない。**
     - **採った判断**: 積まない。
     - **理由**: `memory_events` は `memory_id` を軸にした**記憶の履歴**であり、`recalls`/`outbox` は記憶ではない。
       `events_purged` は「履歴を消した」ことを、履歴自身に残すための行だが（`memory-model.md` §9 の
       「件数と期間のみ」）、`recalls`/`outbox` にはその「履歴を残す先」が無い。積むと、1回の呼び出しごとに
       `memory_events` へ書く副作用が `MemoryStore` の口と `OutboxStore` の口の両方に要り、`OutboxStore` は
       `memory_events` を知らない（別の port）。結果の `purged`/`purgedUsages`/`oldest`/`newest` を呼び出し側が
       ログに残せば、件数と期間は追える。`eraseTenant` も消去の記録を残さない（ADR 0383）。
     - **採らなかった案**: `events_purged` と同じく、`kind` を足して件数と期間を持つ集計行を積む。
       `memory_events.kind` の CHECK 制約の変更（migration）と、`OutboxStore` が `memory_events` へ書く配線が要る。
     - **覆す条件**: オーナーが「recalls/outbox の掃除も DB に痕跡を残したい」と判断したとき。
       その場合は `kind` を足す migration と、`MemoryStore` 側の口に同一トランザクションの追記を足す。
       `OutboxStore` 側は port をまたぐので別の設計が要る。

  7. **索引（migration）は足さない。**測った数字は下の「測ったこと」。要点: 足さなくても1回の呼び出しは
     行数に比例して遅くなるだけで、保守ジョブの許容範囲。足すと全ての recall の INSERT と全ての outbox の
     `complete` が、purge を呼ばない利用者も含めて恒久的に重くなる。

- **検討した代替案**:

  1. **`recalls` を消す前に、活動量の集計（ADR 0290 の代替案1）を実装する。** 採らなかった。
     **ADR 0290 の代替案1（`recalls` を `COUNT` して recall 頻度を測る）は、本 ADR の時点でも未実装である。**
     この口を使うと、その材料（過去に遡って日ごとの recall 回数を数えられる、という `recalls` の性質）が
     **消える**——`olderThan` より古い日の回数は数えられなくなる。`tenant_activity.activity_seq`
     （積算値で、過去に遡れない）は消えない。代替案1を実装する予定の利用者は、集計を先に取るか、
     `olderThan` を集計の窓より長く取ること。
  2. **`Runtime` のメソッドにして `tick()` から自動で呼ぶ。** 採らなかった。保持期間の既定値を要る（決定2）。
  3. **`tenant_settings` に `recall_retention_days` / `outbox_retention_days` を足し、`purgeExpiredEventsByRetention?`
     に倣う口にする。** 採らなかった。既定値と設定の置き場をオーナーに聞かずに決めることになる。
  4. **`failed` 行も期限で消す。** 採らなかった（決定3）。
  5. **`recalls` の削除を `recall_usages` の `ON DELETE CASCADE` に任せる。** 採らなかった。FK の変更は migration であり、
     `eraseTenant` の順序（明示的に子から消す）を変えることにもなる。
  6. **`limit` を任意にして、既定で全件消す。** 採らなかった（決定1）。

- **引き受けた負債**:

  - **既定の保持期間が無い。**呼び出さなければ、`recalls` と `outbox` は増え続けるまま。
  - **`failed` 行は消えない。**ADR 0357 の「止まり続ける job は消えない」は残る。
  - **`recalls.query` の約束の範囲は未決**（決定5）。
  - **`recall_usages` が一緒に消えるので、`reinforce` の根拠になった使用記録の履歴は残らない。**
    強化の結果（`memories` の強度など）は残る。
  - **監査行が無い**（決定6）。
  - **Postgres の `limit` を大きくすると、1回のトランザクションで掴む行が増える。**
    `recalls` は対象を `FOR UPDATE` で掴むので、大きな `limit` は `recordUsage` を待たせる。
    実測していない。小さい `limit` で繰り返す使い方を想定している。
  - **`InMemoryMemoryStore` と Fake の負の `limit` は例外、Postgres は `-1` だけ通る**
    （`purgeExpiredEvents` と同じ非対称。Issue #876）。0以上の整数を渡す前提。

- **これが覆るとしたら**:

  - オーナーが既定の保持期間、または `tenant_settings` 経由の設定を決めたとき（決定2・代替案3）。
  - オーナーが `failed` 行の扱いを決めたとき（決定3）。
  - オーナーが `recalls.query` の約束の範囲を決めたとき（決定5）。
  - ADR 0290 の代替案1（`recalls` の集計）を実装することになったとき——この口との関係（保持期間と集計の窓）を決め直す。
  - 実運用の行数で purge の1回が遅すぎると分かったとき（下の「測ったこと」）。索引 migration を足す。

- **オーナーに聞く事柄**（本 ADR は決めていない）:

  1. `recalls` と完了済み `outbox` の**既定の保持期間**（あるいは既定を持たない、で確定するか）。
  2. `failed` の `outbox` 行の扱い。
  3. `recalls.query` を purge の約束の範囲に入れるか。
  4. 監査行を積むか（決定6）。

## 測ったこと

【実測】2026-09-30、自前の Postgres 17（pgvector 入り、ポート 55873、`initdb` で立てた使い捨て DB）。
`recalls` 40万行＋`outbox` 40万行（96% が完了済み、1% が failed）を `generate_series` で投入し、
`tenant_id` は10テナントに分散（次いで1テナントに寄せて 60万行／58万4千行の完了済み）。器の負荷で数字は
ばらつく。**この数字は「索引を足す判断の根拠」であって、性能保証ではない。**

対象の選択 SQL（`buildPurgeExpiredRecallsTargetSelect` と同じ形）を `EXPLAIN (ANALYZE)`:

| 対象 | 索引なし | 索引あり（候補） |
| --- | --- | --- |
| `recalls`（10テナント分散、1テナント4万行、3万行が対象、`limit 1000`） | 既存の `idx_recalls_by_subject` の範囲走査＋ソート 36.4 ms | 0.9 ms |
| `outbox`（同、4万行が対象） | Seq Scan（40万行を読む）＋ソート 42.9 ms | 0.7 ms |
| 対象が0件 | recalls 1.8 ms／outbox 25.8 ms | 0.03 ms／0.02 ms |

候補の索引: `recalls (tenant_id, created_at, id)`（19 MB／40万行）、`outbox (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL`（18 MB／40万行）。

実装を通した1回の呼び出し（`limit 1000`、1テナントに 60万行の recalls／58万4千行の完了済み outbox）:

| | recalls | outbox |
| --- | --- | --- |
| 索引なし（3回） | 128 / 110 / 94 ms | 100 / 108 / 87 ms |
| 索引あり（3回） | 36 / 18 / 18 ms | 11 / 12 / 10 ms |
| 対象0件 | 21 ms → 1 ms | 39 ms → 0.8 ms |

書き込み側の上乗せ（20,000 回の単発 INSERT／UPDATE を `DO` ブロックで逐次実行、索引なし→あり、3往復）:

| | 索引なし | 索引あり |
| --- | --- | --- |
| recall の INSERT（20,000回） | 218 / 234 / 218 ms | 283 / 266 / 247 ms（+約 12〜30%、1回あたり約 1.5〜3 µs） |
| outbox の `complete` 相当の UPDATE（20,000回） | 152 / 171 / 200 ms | 271 / 225 / 213 ms（+約 7〜78%。ばらつきが大きい） |

`complete` の UPDATE は `completed_at`（索引列）を書くので、HOT 更新にならず索引エントリが増える。

**判断**: 索引なしでも、60万行の1テナントで 1000 行の purge が約 0.1 秒。保守ジョブの許容内と見た。
索引ありは 5〜10 倍速いが、（a）全 recall の INSERT と全 outbox の `complete` に、purge を呼ばない利用者も含めて
恒久的な上乗せが乗る（ADR 0389 の `idx_recalls_digest_band` に続く3本目の `recalls` の索引になる）、
（b）通常の `CREATE INDEX` は作成中に書き込みを止める（0002 と同じ形。40万行で数秒〜）、（c）行数は purge を
呼ぶほど減るので、走査の費用は自己限定的。**足さない。migration 0032 は使わない。**
外挿（1000万行で1回が秒単位になる）は**測っていない**。それが起きたら索引を足す（「これが覆るとしたら」）。

## 確かめていないこと

- **1テナントに数百万行あるときの1回の呼び出し時間**（外挿のみ）。
- **並行の `recordUsage` と purge が実際に衝突したときの挙動**（`FOR UPDATE` の設計上の説明であり、並行の歯は置いていない）。
- **`purgeCompletedJobs` を `claimBatch` と並行に走らせたときの挙動**（`FOR UPDATE SKIP LOCKED` で対象を掴むが、並行の歯は置いていない。完了済みの行は `claimBatch` の対象ではない）。
- **`recalls` の子として `recall_usages` の他に参照する表が将来増えたとき**の扱い（今は `pg_constraint` で1本だけ）。
- 上の数字は自前の1台の器での1回ずつの測りであり、再現性の幅は見ていない。
