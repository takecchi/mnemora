# ADR 0414: `DROP DATABASE` の checkpoint 待ちで afterAll が時間切れになりうることは、測ったうえで直さない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  `packages/postgres` の `test:db` を全体で流したとき、`migrate-ledger-handover.test.ts` の afterAll が
  `Hook timed out in 30000ms.` で赤になった、という報告があった（4回中1回、単体では緑。伝聞）。
  afterAll は `pool.end()` の後、[`dropTempDatabase`](../../packages/postgres/src/__tests__/temp-database.ts)
  （接続0本を最大10秒 poll してから `WITH (FORCE)` 無しで DROP。[ADR 0020](./0020-temp-database-drain-before-drop.md)）を DB 4個に対して呼び、
  最後に admin pool を `end()` する。並列の群は `isolate: false`（[ADR 0397](./0397-postgres-db-tests-isolate-false.md)）で、
  worker ごとの専用 DB を使う（[ADR 0371](./0371-db-tests-per-worker-database.md)）。
  原因を調べ、手元で再現し、**直さない**と判断した。

- **決めたこと**:

  1. **テストも `temp-database.ts` も変えない。`hookTimeout` も伸ばさない。**
  2. **原因の見立てをここに残す**（下の「見立て」）。
  3. **理由**:
     - **CI では出ていない。** 直近3000 run（下の「CI」）で、この afterAll の時間切れは0件だった。
     - **直す案は ADR 0020 の歯を弱める。** `DROP DATABASE` を per-file の afterAll から外して run 終了時にまとめると、
       「自分が開けた接続が閉じ切っていない」ことをその場の DROP の失敗として表に出す、という ADR 0020 の歯が、
       どのファイルの不具合かを指せなくなる。
     - **時間切れの値を伸ばすのは、原因を隠すだけで直しではない。**
  4. **手元での回避策**（下の「手元での回避策」）を書く。

- **見立て**:

  `DROP DATABASE` は、PG17 では即時 checkpoint の完了を待つ（`RequestCheckpoint` に `IMMEDIATE | FORCE | WAIT` を渡す。
  これは PG のソースについての記憶であり、この repo では確かめていない。ただしサーバログの `checkpoint starting: immediate force wait` として、
  DROP のたびに checkpoint が起きるのは観測した）。checkpoint は**クラスタ全体**の dirty ページを書いて fsync するもので、
  checkpointer は1本なので、複数の DROP の checkpoint 要求は直列に回る。
  worker が多く（他ファイルも `CREATE DATABASE` / `DROP DATABASE` を大量に打つ）、fsync が遅い器では、
  最初の DROP が checkpoint を2本続けて待ち、afterAll の合計が 30 秒を超える。
  DB 4個のうち重いのは最初の1個で、2個目以降は checkpoint が空に近く数十 ms で終わる（単体の実測）。

  **テスト側に leak は無い。** `pool.end()`（`pg-pool@3.14.0` の `index.js` 488-499 行）は、checkout 中の client が未 release だと
  `_clients` が空にならず永遠に resolve しないが、このファイルの `runMigrations` は
  失敗時も finally で lock client を release する（`migrate.ts`、`advisory-lock.ts`）。読んだ範囲では leak の経路は見当たらず、
  自然発生した時間切れでも、サーバログに 25.9 秒の `DROP DATABASE` が実行中として残っており、`pool.end()` の段は終わっていた（この回に計測は入れていない。DROP の実行はサーバログで確認）。

- **測ったこと**:

  【実測】2026-09-30、自前の Postgres 17.11（Debian、pgvector 入り、`initdb` で立てた使い捨て、ポート 55600 台、
  `log_checkpoints=on`、`log_min_duration_statement`、`log_line_prefix` にタイムスタンプと DB 名）。
  器は nproc=48、メモリ約 330 GB（他の担い手と共有）、データディレクトリは overlay（`/tmp` 配下）。

  ### 陽性対照（単体、細工は手元の変更で commit していない）

  afterAll の冒頭に、環境変数で切り替える細工を足した。`pools ended` / `dropped <DB>` を追記する計測も足した。

  - **checkpointer を止める細工**: `pg_stat_activity` の `backend_type='checkpointer'` の pid に `SIGSTOP` を送り、
    45 秒後に別プロセスが `SIGCONT` する。**2回中2回**、`Hook timed out in 30000ms.`（`migrate-ledger-handover.test.ts:144:3`）で赤になり、
    4 tests は通った。計測ログは `pools ended` の1行だけで、`dropped` が出なかった。
  - **leak の細工**: `openedPools[0].connect()` を release せずに置く。1回、同じ形の赤になった。計測ログは1行も出ない
    （`pool.end()` で止まる）。**`pools ended` が出るかどうかで、2つの細工を区別できる。**
  - **細工なし**（計測だけ）: 単体3回とも緑。afterAll の所要は 0.45 秒、7.4 秒、8.1 秒と散った。
    8 秒の回のサーバログでは、最初の DROP が 7359 ms で、その checkpoint は `wrote 12956 buffers`、`sync=7.213 s`、`sync files=13856`、
    2個目以降は `wrote 2 buffers` で約 25 ms。

  この細工は「checkpoint が返らない」極端な形で、**機構と赤の形を示すだけ**である。CI の赤の頻度は示さない。

  ### 自然発生（全体実行、`test:db` 1本、CPU を絞らず既定の maxWorkers＝47）

  | 条件 | 時間切れ | 1秒以上の DROP | 最大 |
  | --- | --- | --- | --- |
  | 47 workers・fsync=on（1回） | `migrate-ledger-handover` の afterAll 1本 | 24件 | 25.90 秒 |
  | 47 workers・fsync=off（1回、fsync のみ変更） | 0件 | 1件 | 1.68 秒 |
  | 3 workers（`taskset -c 0-3`、main e3045d8 時点）・fsync=on（1回） | 0件（全 2304 tests 緑） | 別ファイルの DROP の最大 | 8.04 秒 |

  fsync=on の時間切れ（vitest の出力、逐語）:

  ```
   ❯ |postgres-db-parallel| src/__tests__/migrate-ledger-handover.test.ts (4 tests) 31194ms
   FAIL  |postgres-db-parallel| src/__tests__/migrate-ledger-handover.test.ts > マイグレーション台帳の引き継ぎ（_mnemo_migrations → _mnemora_migrations）
  Error: Hook timed out in 30000ms.
  ```

  同じ回の DROP DATABASE の所要（サーバログ、上位10件）:

  | 所要 | DB |
  | --- | --- |
  | 25.90 s | `mnemora_ledger_handover_not_reapplied` |
  | 25.17 s | `mnemora_upgrade_from_v1_0_1` |
  | 24.99 s | `mnemora_lock_role_schema_migrate` |
  | 20.76 s | `mnemora_purge_across_spaces_enum` |
  | 20.46 s | `mnemora_ext_lock_race_unspec_s1_0` |
  | 19.27 s | `mnemora_ds_isolate` |
  | 18.42 s | `mnemora_erase_tenant_concurrent_test` |
  | 16.63 s | `mnemora_trgm_probe_schema_fresh` |
  | 15.31 s | `mnemora_756_boundary_race` |
  | 15.26 s | `mnemora_labels_icu_en_us` |

  同時に開いていた DROP は最大15本。時刻（サーバログの JST）と checkpoint の突き合わせ:

  | 時刻 | 出来事 |
  | --- | --- |
  | 15:51:17.3 | checkpoint 1 開始（`immediate force wait`）。25.90 秒の DROP はこの直後（完了時刻からの逆算で 15:51:17.9 頃）に開始 |
  | 15:51:31.96 | checkpoint 1 完了。`wrote 12784 buffers`、`sync=14.399 s`、`total=14.659 s`、`sync files=16360` |
  | 15:51:31.97 | checkpoint 2 開始（`immediate force wait wal`） |
  | 15:51:43.79 | checkpoint 2 完了。`wrote 13093 buffers`、`sync=9.967 s`、`total=11.820 s`、`sync files=80297`、`distance=2000544 kB` |
  | 15:51:43.8 | 開いていた DROP が一斉に完了（25.90 秒の DROP を含む） |

  最初の DROP の所要（25.9 秒）は、checkpoint 2本の total の和（14.7 + 11.8）にほぼ等しい。この後に続く3.4 秒の DROP などを足すと、
  afterAll の合計が 30 秒を超えた。checkpoint の時間は write（0.07〜0.2 秒）ではなく sync（fsync）が占める。
  DROP と checkpoint の対応は時刻の一致で見ており、DROP 1件ごとに待った checkpoint を特定したわけではない。

  この回と fsync=off の回には、時間切れとは別に `sorry, too many clients already` の失敗が混ざった（下の「手元での回避策」）。

  ### CI

  `takecchi/mnemora` の workflow CI の直近3000 run（2026-09-08 から 2026-09-30）を探した。
  conclusion が failure の run の最終 attempt と、`attempt>1` の run の過去の attempt を合わせた621件のうち、
  `gh run view --attempt N --log-failed` に中身が残っていたのは571件（残りは失敗ジョブの無い attempt で空）。
  **探し方の陽性対照**: run 36664582749 は今は success だが、attempt 1 が failure で、attempt 1 のログから
  `expected 14 to be 15`（[PR #1489](https://github.com/takecchi/mnemora/pull/1489) の本文と同じ）が拾えた。
  結果は次のとおり。

  - `migrate-ledger-handover` の afterAll の時間切れ: **0件**。
  - `Hook timed out` は run 34433449426（2026-09-10、枝 `feat/extension-verify-mode`）の1件のみ。
    `extension-mode.postgres.test.ts:127` の afterAll だが、同じファイルの `it` も `Test timed out in 30000ms` で落ちており、
    afterAll より前から詰まっていた別件である（`isolate: false` の前）。
  - `migrate-ledger-handover` が落ちた run は 36253154462 の1件で、DB の無い門で `connect ECONNREFUSED 127.0.0.1:1`。時間切れではない。

  ### 別の器での伝聞

  別の器（runner-2）で素の main の `test:db` を全体で1回流したところ、`dedicated-schema` / `migrate-ledger-handover` /
  `purge-across-spaces` / `role-name-schema-lock-key` / `search-stats-presence-scope` / `upgrade-from-released` /
  `migrate-extension-lock-race` / `migrate-partial-apply` / `vector-space-dimensions-limit` の9ファイルが afterAll の
  `Hook timed out in 30000ms` でファイルごと落ち、`list-labels-codepoint-order` の `it` が1本時間切れになった、という報告を受けた（伝聞）。
  CI は毎回緑。この10ファイルはすべて afterAll（または `it`）で `DROP DATABASE` を打っている（報告者が確かめた範囲）。
  ログ本体はこの ADR の作成者は見ていない。

  ### 設定の比較（CI の service container）

  `.github/workflows/ci.yml` の postgres ジョブは `pgvector/pgvector:pg17` を使い、`POSTGRES_INITDB_ARGS` のほかに Postgres の設定を渡していない
  （`command:`・`-c`・`tmpfs` なし）。したがって既定値で、`initdb` 直後の `postgresql.conf` と同じはずである:
  `shared_buffers=128MB`、`fsync=on`、`checkpoint_timeout=5min`、`max_wal_size=1GB`、`min_wal_size=80MB`、`checkpoint_completion_target=0.9`、
  `max_connections=100`（`wal_sync_method` はコメントアウトのまま。Linux の既定と推定）。手元の実験も、`fsync` とログ以外は同じ既定値で動かした。
  **設定に違いは無い。違うのは CPU 数（手元 48、CI は約4 vCPU で workers は約3本）、ディスク、書き込み量である。**
  CI の docker のディスクの fsync 遅延は、ログからは分からない。

- **手元での回避策**:

  - **使い捨てのインスタンスは `-c fsync=off` で立てる。** このテストは永続性（クラッシュ後の復旧）を主張していない。
    fsync=off の全体実行では、1秒以上の DROP は1件（1.68 秒）で、時間切れは0件だった。
    ⚠ 本番や、残すデータのあるインスタンスには使わない。
  - **worker を絞る**（`taskset -c 0-3` など。`resolveDefaultMaxWorkers()` は `availableParallelism() - 1` で、affinity を見る）。
    3 workers の全体実行は全緑で、DROP の最大は 8 秒だった。
  - **手元の 47 workers では `max_connections=100` が足りない。** `sorry, too many clients already` が別に出る
    （`migrate-extension-lock-race` 1件、fsync=off の回は `dedicated-schema` の5件と `readme-unbound-promises` の1件）。
    時間切れとは別の原因で、`max_connections` を上げるか worker を絞る。

- **引き受けた負債**:

  - **fsync が遅く worker が多い器では、`DROP DATABASE` を打つ afterAll が時間切れで赤になりうる。** テストの主張は変わらず、赤になるのは器の側の遅さである。
  - **赤のメッセージは `Hook timed out in 30000ms.` だけで、どの段（`pool.end` / drain / `DROP`）で待ったかは出ない。**
    段ごとの計測や名前付きの時間切れは足していない。次に CI で出たときは、この ADR の陽性対照の形（`pools ended` の有無）で切り分けること。

- **これが覆るとしたら**:

  - **CI で同じ形の時間切れが出たとき**（`gh run view --log-failed` で `Hook timed out` と対象ファイルが拾える。上の「CI」の探し方が使える）。
  - **手元・別の器での再現が、開発の妨げになる頻度で出続けたとき。**
  - そのとき、原因を除く案として検討できるもの（今回は採っていない）:
    1. 4個の DB の DROP を per-file の afterAll から外し、`global-setup-worker-databases.ts` の teardown にまとめる
       （hook の時間切れの外で、他ファイルと競合しない時点）。名前は固定で、`createBlankDatabase` が冒頭で同名を DROP するので残骸は次回に片付く。
       **ADR 0020 の歯の弱まり方を先に検討すること**（決定3）。
    2. afterAll を段（`pool.end` / drain / `DROP`）に分け、段ごとに名前付きの時間切れを付ける（診断のみ）。
    3. `pool.end()` の前に checkout 中の client が0本であることを assert する（leak なら時間切れでなく明示のエラーになる）。

## 確かめていないこと

- **CI の実物の赤がこの経路かどうか。** CI では0件で、CI の checkpoint の所要は計っていない。
- **時間切れの頻度。** 上の各条件は1回きりで、再現率は言えない。手元の伝聞（4回中1回）を手元で再現したわけではない。
- **3 workers（CI に近い負荷）の全体実行は1回だけで、DROP の最大は 8 秒だった。** 30 秒に届くかどうかは見ていない。
- **runner-2 の CPU 数・ディスク・`max_connections` は未確認。** 9ファイルが落ちた回と、今回1ファイルだけ落ちた回の差の理由は分からない。
- **DROP 1件ごとに待った checkpoint の特定**（時刻の一致で見ただけ）。
- **PG17 の `DROP DATABASE` が、全 backend への smgr release の barrier も待つか**（記憶による推測で、未確認。待つならその分も上乗せされうる）。
- **`wal_sync_method` など、CI の実際の値**（既定値からの推定）。
- 上の数字は自前の1台の器での測りであり、絶対値は目安である。
  推測を事実の顔で書かない。これは北極星の問い3（説明できるか）の、文書への適用である。
