# ADR 0460: 「同じ Pool／別の Pool／別のプロセス」から 23・26・27・30 巡目の操作を同時に当て、`registerEmbeddingSpace` が `max: 1` で返らない穴と `lock_timeout` を 0 に書き換える穴を直した（穴探し33巡目）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先の委譲先が書いた。面の選び方と直し方の線（断る・落とす入力を増やさない。遡ったデータの書き換え・既定値の変更・v2 相当は材料だけ）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**:

  穴探し33巡目。面は、[ADR 0447](./0447-lifecycle-operation-state-matrix-round23.md)（23巡目）・[0450](./0450-contested-group-operation-state-matrix-round26.md)（26巡目）・[0453](./0453-embed-job-and-reinforce-state-matrix-round27.md)（27巡目）・0454（30巡目）の「測っていないこと」が**4本とも**残した「**複数プロセス・複数接続プール**」（0447:61、0450:61、0453:103・121、0454 の「測っていないこと」）。
  あわせて、SQL_ASCII の DB も4本すべてが「測っていない」と書いている（この巡は当てない。CI には SQL_ASCII の脚が既にあり、コミット済みの歯は両方の脚で走る）。

  **既存の歯は、並行をほぼ全部 1 つの `Pool` の中で当てていた**【現物】。`getTestClient()`（`test-db.ts:42`）が共有する 1 つの `Pool` の上で `Promise.all` する歯が、`tick-concurrent-extract`・`reextract-concurrent-extract`・`reextract-forget-race`・`consolidate-reflect-*`・`recall-purge-race`・`archive-decayed-concurrency` など。冒頭に「プロセスを並列に起こさない」と書いてあるものもある。
  別の `Pool`（`createPostgresClient` をもう 1 本）は `contested-pair-lock-order-concurrency`・`resolve-contested-pair-scope-and-concurrency`・`restore-superseded-concurrent-forget`・`memory-store-update-status-concurrency`・`outbox-skip-locked-non-blocking`・`erase-tenant-*`・`vector-space-concurrency`・`migrate-concurrency` など。
  **別のプロセス（`child_process`）で Postgres の store を当てる歯は 1 本だけ**——`packages/bullmq` の `concurrent-tick.redis.test.ts`（[ADR 0325](./0325-bullmq-tick-driver.md)）で、embed ジョブの**二重 claim が 0** であることしか見ていない。claim の**後**（embed の upsert・`complete`）、extract・consolidate・reflect のジョブ、他の操作との組は、別プロセスでは当たっていなかった。

  除外（当て直さない）: outbox の二重 claim 単体（ADR 0206・0325）と `complete`/`fail` の CAS の単体（0142・0440）、migrate どうし・`registerEmbeddingSpace` どうしの advisory lock（0017・0018・0331）、`Pool` の接続断（0349・0444・0448）、store の conformance（31巡目）、文書の横の点検（32巡目）、実モデル・実 LLM、SQL_ASCII。

  【実測】手元の Postgres 17（UTF8、`C.UTF-8`、`max_connections=200`）に、使い捨ての探り棒（commit していない。`.hunt-r33/probes/`）で、**同じ組を 3 つの配置で撃って結果を比べた**:
  - **samePool**: 1 つの `PostgresClient` を 2 つのワーカー（それぞれ `createRuntime` と各 store）で共有する。
  - **separatePool**: ワーカーごとに `createPostgresClient`（別の `Pool`、同じプロセス）。接続は先に温める（`outbox-store.ts:63` の罠）。
  - **process**: ワーカーごとに `tsx` で別の OS プロセス（`child_process.spawn`、IPC で足並みを揃える）。Redis は使わない。
  ワーカーは、時計・LLM・埋め込みの 3 つに「門」（IPC で開く）を持つ。順序は時計と門で決め、タイミングには頼らない。同時に撃つ組は、親が行（またはテーブル）を `FOR UPDATE` で握り、`pg_stat_activity` で k 本が `wait_event_type = 'Lock'` になったのを確かめてから離す。
  対象は Postgres だけである。**この面では、testkit のインメモリ実装との diff は取れない**（インメモリ実装に Pool もプロセスも無い）。diff の代わりに、「3 つの配置で結果の集合が一致するか」を見た。

  **結論: 穴が 2 件（どちらも `registerEmbeddingSpace`・advisory lock の部品。直した）。直さなかった穴が 1 件（migrate × `registerEmbeddingSpace`）。「約束の外」の記録が 1 件（`eraseTenant` × `observe`）。3 つの配置のあいだで結果が割れたセルは 0。**
  別のプロセスの組**だけ**が赤になる変異は、見つからなかった（下の「変異試験」）。

  ### 穴（直した）A: `registerEmbeddingSpace` が `max: 1` の `Pool` で返らない

  `registerEmbeddingSpace` は advisory lock のために `pool.connect()` で接続を 1 本借り切り、**その接続を握ったまま**、DDL（`CREATE TABLE`・`CREATE INDEX`×3、`COMMENT ON TABLE` の読み書き）を `pool.query`（**別の接続**が要る）で打っていた【現物】`vector-space.ts`（直す前の 351・364・369・413・437 行）。
  `max: 1` だと、`pool.query` は借り切られた接続の返却を待ち、返却は `pool.query` の完了を待つので、誰も進めない。`lock_timeout` は advisory lock の待ちにしか効かず、`Pool` の待ちには効かない。`connectionTimeoutMillis` を渡していなければ**返らない**。【実測・直す前】

  | 入力 | 直す前 | 直した後 |
  | --- | --- | --- |
  | `new Pool({ max: 1 })` で `registerEmbeddingSpace(pool, space, { lockTimeoutMs: 2000 })` | **8 秒待っても返らない**（探り棒が打ち切った） | 19 ms で通る |
  | 同じ、`connectionTimeoutMillis: 4000` を付けた歯 | `Error: timeout exceeded when trying to connect`（`vector-space.ts:351`、`CREATE TABLE`） | 通る |
  | `max: 2` | 通る（59 ms） | 通る |

  `runMigrations` は `max: 1` でも通る【実測】（116 ms、32 本適用）。0331 が一度 `max: 2` の既存の歯で接続を使い切って差し戻したあと、拡張の lock を同じ接続で取る形に直してあるため。`registerEmbeddingSpace` だけが残っていた。

  ### 穴（直した）B: `registerEmbeddingSpace`・`runMigrations` が、呼び終えた接続の `lock_timeout` を `0` に書き換える

  `acquireAdvisoryLock` は接続に `set_config('lock_timeout', <lockTimeoutMs>, false)`（セッション）を敷き、`releaseAdvisoryLock` と失敗の経路は `set_config('lock_timeout', '0', false)` で戻していた【現物】`advisory-lock.ts`（直す前の 137・251 行）。
  戻す値が `0` なので、**接続側で渡した `lock_timeout`（接続文字列の `options`・`PoolConfig.options`・`ALTER ROLE … SET`）が、その接続だけ消える**。README（`packages/postgres/README.md`「`lockTimeoutMs` は DDL の表ロック待ちには効かない」）は「上限を付けるなら接続側で」と案内し、`runMigrations` が戻すのは「セッションの既定値」だと書いていた。実装は `0` を書いていたので、書いてあることと違った。【実測・直す前】

  | 入力 | 直す前 | 直した後 |
  | --- | --- | --- |
  | `new Pool({ max: 2, options: "-c lock_timeout=7s" })` で `runMigrations`、`registerEmbeddingSpace` のあと、2 本の接続の `SHOW lock_timeout` | `0` と `7s`（借り切った 1 本が `0`） | `7s` と `7s` |

  `0` は「待ちに上限が無い」。被害は、**`registerEmbeddingSpace`・`runMigrations` を呼んだ `Pool` の 1 本だけ**、以後のアプリのクエリがロック待ちで止まる時間の上限が外れること（[ADR 0442](./0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md) が書いた「待っている DDL の後ろに並んで止まる」の上限を、アプリ側から外してしまう）。同じ `Pool` の中にだけ漏れる（別の `Pool`・別のプロセスには出ない）。

- **決めたこと**:

  1. **`registerEmbeddingSpace` は、DDL を advisory lock を握った接続（`lockClient`）の中で打つ**（`pool.query` をやめる）。`recordOrCheckEmbeddingSpace` も `lockClient` を受ける。必要な接続は 2 本から 1 本になる。`max: 1` の穴（A）が閉じる。
  2. **`lock_timeout` は advisory lock を取っている間だけ敷き、取れたら `RESET lock_timeout` する**（`runMigrations` が既にしている形）。理由: 接続を借り切ったままだと、DDL が `lockTimeoutMs` の影響下に入り、表ロックを待つ DDL が `55P03` で落ちる入力が**増える**。以前の DDL は接続側の既定値で待っていた。
  3. **`acquireAdvisoryLock` の失敗の経路と `releaseAdvisoryLock` は、`'0'` を書く代わりに `RESET lock_timeout` で接続の既定値へ戻す**（穴 B）。既定値が `0` の接続（何も渡していない利用者）では、結果は同じである。
  4. **歯を 1 ファイル足した**: `vector-space-single-connection-pool.test.ts`（3 本）。(1) `max: 1`（`connectionTimeoutMillis` 付き、`lock_timeout=7s` 付き）で通り、テーブルと索引が出来て、2 回目も通り、`SHOW lock_timeout` が `7s` のまま。(2) `max: 2` で `runMigrations`・`registerEmbeddingSpace` のあと、2 本の接続とも `7s`。(3) `memories` を `ACCESS EXCLUSIVE` で握った裏で `lockTimeoutMs: 1000` の `registerEmbeddingSpace` を呼び、約 2.5 秒の DDL 待ちが `lockTimeoutMs` に縛られず通る（決定 2 の歯）。`pg_stat_activity`・`pg_locks` を読まないので、並列の群のまま（`SERIAL_TEST_FILES` に入れていない）。
  5. **直さない**ものは「引き受けた負債」の表に、再現・結果・緊急度・覆る条件を付けて置いた。

  **トランザクションの境界が変わる点**（決定 1 の影響。書かないと変更が見えない）:
  - 以前は、`pool.query` の 1 文ごとに、**その時 Pool が貸した任意の接続**の上の、暗黙の（autocommit の）トランザクションだった。今は、**`lockClient` という同じ 1 本の接続**の上で、`BEGIN` を開かずに打つ。**文ごとの暗黙のトランザクションという境界は変わらない**（`CREATE TABLE` と `CREATE INDEX` と `COMMENT` が 1 つのトランザクションにまとまるわけではない。途中で落ちると、テーブルだけ残るなど、以前と同じ中途の状態が残りうる——ADR 0018 の C-2 の注意と同じ）。
  - 変わるのは、**6 文が同じセッションで走る**こと。セッションの設定（`search_path`・`lock_timeout`・`statement_timeout` など、接続側で渡した値）は 6 文とも同じ接続のものになる（以前は文ごとに違う接続の値でありうるが、同じ `Pool` の接続は同じ起動パラメータなので、実害の差は【判断】無い）。`search_path` は schema 指定時は完全修飾で、未指定時は接続の既定値に頼る点も同じ。
  - 変わるのは、**ロックを握った接続が切れたとき**。以前は DDL が別の接続で走り続け、最後の `pg_advisory_unlock` で初めて失敗した。今は次の DDL の文が接続の失敗で落ちる（`acquireAdvisoryLock` が付けた何もしない `error` リスナーはそのまま。プロセスは落ちない）。【現物】。この形を実際に切って確かめてはいない【未確認】。
  - 変わるのは、**DDL が `lockTimeoutMs` の影響下に入りかねなかった点**だが、決定 2 の `RESET` で以前と同じにした（歯 3 が縛る）。

- **検討した代替案**:

  - **`max: 1` を断る（`pool.options.max < 2` なら例外）**: 却下。今は止まって失敗する入力を通すようにできるのに、断る入力を増やすことになる（線に反する）。
  - **DDL だけ `pool.query` のまま、`max: 1` のときだけ別の経路**: 却下。2 つの経路になり、片方に歯が要る。
  - **`RESET lock_timeout` をやめて、DDL にも `lockTimeoutMs` を効かせる**: 却下。表ロックを待つ DDL が `55P03` で落ちる入力が増える（README は「DDL の表ロック待ちには効かない」と書いている）。
  - **`'0'` を書き続ける（穴 B を直さない）**: 却下。接続側で渡した上限が黙って消える。READMEの案内（上限は接続側で）と食い違う。

- **引き受けた負債**:

  | # | 内容 | 再現・結果 | 緊急度 | 直さなかった理由 | 覆る条件 |
  | --- | --- | --- | --- | --- | --- |
  | D1 | **`runMigrations`（0022）× `registerEmbeddingSpace` が同時だと、後者が 23505 で落ちうる**。2 つの advisory lock のキーが別（`MIGRATION_LOCK_KEY` と `REGISTER_EMBEDDING_SPACE_LOCK_KEY`）で、0022 の DO ブロックと `registerEmbeddingSpace` が同じ名前の索引を `CREATE INDEX IF NOT EXISTS` する。これは非アトミック（ADR 0018） | 【実測】旧版（0022 未適用）から上げる形を作り（0022 の台帳行と索引を落とす）、別の `Pool` 2 本で同時に撃った。30 回中 **2 回**、`registerEmbeddingSpace` が `23505`（`pg_class_relname_nsp_index`）で reject。`runMigrations` は 30 回とも成功。索引は 4 本そろった。対照（`runMigrations` だけ）は 2 回とも成功。再実行すれば通る | 低（0022 より前の版から上げた直後の、同時起動のときだけ。再起動で直る） | 直し方が決まっていない。(a) 2 つのキーを共有すると、0331 が避けた「無関係な待ち」が戻る。(b) `registerEmbeddingSpace` が 23505/42P07 を握って 1 回やり直すのは、断る入力は増えないが、IF NOT EXISTS の非アトミック性を呼び出し側で隠す形になる。材料だけ（クローン miku の判断を待つ） | ローリングデプロイでの失敗の報告が来たとき。0027 の DO ブロック（`memory_id` の索引、同じ形）も同じはずだが、0027 は別の素の `CREATE INDEX`（IF NOT EXISTS 無し）を含み、この探り棒では分けて当てられなかった【未確認】 |
  | D2 | **`eraseTenant` × `observe` が 23503（外部キー違反）で落ちうる**（ADR 0383 追記2「そのテナントへの書き込みを止めてから呼ぶ」の範囲の外） | 【実測】`observe`（sync、3 回）を続けながら `eraseTenant(limit: 1000)` を呼ぶ。40 回中 samePool 4、separatePool 3、process 5 で `eraseTenant` が `23503`。**配置で割れない**。`observe` は 3 回とも ok。再び `eraseTenant` を呼べば 0 件になり、`memories`・`outbox`・`observations` は残らなかった | **約束の外**（穴に数えない） | 約束が「止めてから呼ぶ」。書き込み側に xact lock を取らせると、書き込みのコストと契約が変わる（材料だけ） | 追記2の約束を変えるとき |
  | D3 | **リースの判定はプロセスの時計（JS の `clock.now()`）で決まる**。DB の `now()` は `updated_at`・`created_at` だけ【現物】`outbox-store.ts:108-170` | 【実測】2 つのワーカーの時計をリース長×2 ずらした（時計の進んだ側が先に奪い返す）形が、S1・S2・S2c の全セルで ADR 0347・0142 の記述どおり。境界ちょうど（`claimed_at + leaseMs`）で奪い返す形も、3 配置とも同じ（`<=`）。**ずれの大きさを変えて測ってはいない** | 低（NTP の前提） | 材料だけ（クローン miku の線: リースの判定を DB の `now()` に変える案、時計のずれを断る案） | 時計のずれによる二重処理の報告が来たとき |
  | D4 | **`reflect` の再配達で内省が 2 倍になる**（既知: `docs/memory-model.md` 行 13 の注記、ADR 0347） | 【実測】seed 2 件、`kinds: ["reflect"]` を、リース切れで 2 つのワーカーが取る。内省が 4 件（`内省@w1`×2、`内省@w2`×2）。3 配置とも同じ。`consolidate` は 1 件（統合先は後から書いた側の 1 件で、元の 2 件は superseded）で、二重にならない | 既知 | 既知（クローン miku の線で材料止まり） | — |
  | D5 | **ANALYZE の数えがプロセスごと**。`memoriesWriteCounts`（`memories-statistics.ts:58`）・`upsertCountsByTable`（`embedding-statistics.ts:88`）はモジュールスコープの `Map`。N プロセスなら累計が N 個に割れ、閾値（1000, 2000, 4000…）に届く頻度が変わる | 【現物】のみ。複数プロセスで測っていない【未確認】 | 低 | クローン miku の線で、ANALYZE の頻度の差は文書だけ（このADRでは書かない。必要なら別の巡） | — |
  | D6 | **`PgvectorCapabilityGate`・`StatsPresenceGate` はインスタンスごと**（`vector-store.ts:91-103,428-456`、ADR 0374 決定 2）。別プロセスで ANALYZE や pgvector の更新があっても、覚えた側は気づかない | 【現物】のみ【未確認】 | 低 | 設計（ADR 0374 が大域にしないと決めた） | — |
  | D7 | `decay_clock` の切り替え × observe・tick・reinforce | 【未確認】（当てていない。読みと書きが別の文である点は 0453 が既に挙げている） | — | 余力 | — |

  **S8（`eraseTenant` どうしの同時）は、この探り棒では陽性対照が取れなかった**: `lockTenantForErase` の呼び出し 3 箇所（memory-store・vector-store・outbox-store）を全部外しても、3 配置とも reject が 0 のままだった。「出なかった」を根拠にしない（探り棒の seed が、既存の歯 `erase-tenant-same-tenant-concurrent.postgres.test.ts` の `seedAllTablesForTenant` ほど全部の表を埋めていない）。この組は既存の歯（別の `Pool`）に任せる。

- **これが覆るとしたら**:

  1. `registerEmbeddingSpace` が DDL を `BEGIN`〜`COMMIT` の 1 トランザクションにまとめたくなったとき（今は文ごと。中途の状態が残りうる）。そのときは `lockClient` を使う今の形が足場になる。
  2. `lock_timeout` を `RESET` でなく明示の値で戻すべき事情が出たとき（接続の既定値を信じられない運用）。
  3. D1 の失敗の報告が来たとき。直し方（キーの共有か、23505 の再試行か）をオーナーに問う。

- **測ったこと**（【実測】2026-10-01、Postgres 17、UTF8（`C.UTF-8`）、`max_connections=200`、1 ファイルずつ名指し）:

  **セルの数（配置ごと）: 21**（× 3 配置 = 63）。穴: **2**（A・B。どちらも配置とは無関係で、`Pool` の使い方の穴。直した）。**配置のあいだで結果が割れたセル: 0**（順序の違いは下）。

  | 組 | セル | 試行（配置ごと） | 結果（3 配置で一致） |
  | --- | --- | --- | --- |
  | S1 extract × extract（リース切れ。ADR 0347 の 3 形: 違う本文 A/B、同じ本文 A/A、遅れた側が LLM 失敗 null/B） | 3 | 3 | 遅れた側は `complete` がリース競合（`leaseConflicts: extract:complete`）。A/B は 2 件 active、A/A は 1 件、null/B は B と全文フォールバックの 2 件。outbox は `attempts 2 / worker-2 / completed`。ADR 0347 の記述どおり |
  | S2 embed × embed（リース切れ）＋変種 forget／purge | 3 | 6 | 埋め込み行は 1 件（二重にならない）。遅れた側は complete がリース競合。forget の変種は `forgotten/ready`・埋め込み 1 件、**purge の変種は埋め込み 0 件**（遅れた側の upsert が purge を見直す。#1035 の直しが別プロセスでも効く） |
  | S2b embed のリース境界ちょうど | 1 | 4 | `claimed_at + leaseMs` ちょうどで奪い返せる（`<=`） |
  | S2c 遅れた側が、奪い返した側の処理中に complete | 1 | 4 | 遅れた側の complete は拒まれ（`attempts` の CAS）、行は奪い返した側の完了まで未完了のまま |
  | S3 consolidate／reflect × 同じ（リース切れ） | 2 | 4 | consolidate は統合先 1 件、reflect は D4 のとおり |
  | S4 contested の対: `markContested(A,B)` × `markContested(B,A)`／× `forget(A)`／× `forget(B)`（障壁: 親が行を握る） | 3 | 12 | `conflict`＋`contested`（逆順）、`conflicted`＋`contested`（forget）。**`STALE`・`PAIR-BROKEN` は 0**。forget が先に勝つ順序（`conflict`＋`forgotten`）は、samePool だけ forget-A・forget-B とも 1/12、separatePool・process は 0/12。どちらも許される結果で、不変条件は 0 件 |
  | S5 `reextract` × `forget`（障壁） | 1 | 8 | `ok`＋`conflicted`（superseded A と active B）。samePool だけ 8 回中 2 回、forget が先に勝った（`forgotten`）。順序の違いで、種類の違いではない |
  | S6 `eraseTenant` × `observe` | 1 | 40 | D2。3 配置とも 7〜13% で 23503 |
  | S7 同時の tick（リース切れ無し）で embed の二重 claim が無い（障壁: `LOCK TABLE outbox IN SHARE ROW EXCLUSIVE MODE`） | 1 | 20 | 二重 claim 0、埋め込み 3 件 |
  | S8 `eraseTenant` × `eraseTenant` | 1 | 6 | reject 0。**陽性対照が取れていない**（上） |
  | S9 consolidate／reflect の LLM 待ちの間に別ワーカーが forget（±purge） | 4 | 4 | すべて `aborted_source_forgotten`。書かれた統合・内省は 0 |

  **探り棒の別の組**:
  - `max: 1` の `registerEmbeddingSpace`（穴 A）、`lock_timeout` の戻し（穴 B）。
  - `runMigrations` × `registerEmbeddingSpace`（D1）: 30 回。
  - `runMigrations` を `max: 1` で（通る）。

  **走らせたテスト（ファイル名指し）**: `packages/postgres/src/__tests__/` の `vector-space-single-connection-pool.test.ts`（新しい 3 本）、`vector-space-concurrency.test.ts`、`advisory-lock-cleanup.postgres.test.ts`、`postgres-defaults-doc.postgres.test.ts`、`migrate-concurrency.test.ts`、`role-name-schema-lock-key.postgres.test.ts`、`schema-namespace.test.ts`、`migrate-connection-loss.test.ts`、`migrate-extension-lock-race.test.ts`、`embedding-statistics.postgres.test.ts`、`dedicated-schema.postgres.test.ts`、`vector-space-dimensions-limit.test.ts`、`erase-tenant-fk-indexes.postgres.test.ts`、`embedding-zero-norm-migration.postgres.test.ts`、`purge-across-spaces.postgres.test.ts`、`upgrade-from-released.postgres.test.ts`、`embedding-space-table-enumeration-consistency.postgres.test.ts`、`migrate-partial-apply.test.ts`、`migrate-lock-timeout-scope.test.ts`、`migrate-ledger-handover.test.ts`、`erase-tenant-same-tenant-concurrent.postgres.test.ts`。全テストは走らせていない。

  **変異試験**（`cp` で退避→変異→探り棒または歯が変わることを確認→戻す。戻した後に `git status --short` が変更なしの状態に戻ることを確認）:

  | # | 変異 | 結果 |
  | --- | --- | --- |
  | M1 | `claimBatch` の `FOR UPDATE SKIP LOCKED` を削る（S7、障壁つき） | 二重 claim: samePool 5/20、separatePool 4/20、**process 10/20**（直した後ではなく元の実装で緑 20/20 を先に確認）。**障壁なしの同じ組は 1/30・0/30・1/30**で、歯が弱い（`outbox-store.ts:63-67` の注意と同じ）。process が一番出やすいが、配置だけの赤ではない |
  | M2 | リースの `claimed_at <= …` を `<` にする（S2b） | 3 配置とも 3/3 で変わった（取り直せず、遅れた側が完了する） |
  | M3 | `complete` の `AND attempts = ${expectedAttempts}` を外す | S2（plain）は**変わらなかった**（「最初の終端が勝つ」の `completed_at IS NULL` が先に守る）。S2c が 3 配置とも 3/3 で変わった（遅れた側の complete が通り、`first: p1`） |
  | M4 | `markContestedPair` の `ORDER BY id ASC FOR UPDATE` から `FOR UPDATE` を外す（S4） | 逆順の対が 3 配置とも 12/12 で `40P01`（deadlock）になった |
  | M5 | `lockTenantForErase` の呼び出し 3 箇所を外す（S8） | **変わらなかった**（上。陽性対照が取れていない） |
  | M6 | 決定 3 の戻しを `'0'` に戻す | 歯(2) が赤（`['0','7s']` ≠ `['7s','7s']`）、歯(1) も赤 |
  | M7 | 決定 2 の `RESET lock_timeout`（取れたあと）を外す | 歯(3) が赤（`error: canceling statement due to lock timeout`、1.2 秒） |
  | M8 | 決定 1 を入れる前の実装（`vector-space.ts`・`advisory-lock.ts` を HEAD の版に戻す） | 歯(1) が赤（`timeout exceeded when trying to connect`）、歯(2) が赤（`['0','7s']`）、歯(3) は緑（「以前は縛られなかった」ことの確認）。戻して 3 本とも緑 |

  **別のプロセスの組だけが赤になる変異は、見つからなかった**。M1 の process の検出率が最も高かったのが、配置による唯一の違いである。DB 側のロックと CAS は、3 配置で同じ形に倒れる（DB のセッションはどれも別の接続だから）。配置で変わりうるのは `Pool`・インスタンス・プロセスが持つ状態（穴 A・B、D5・D6）だった。

- **当てた形**（探して問題が無かった点）:

  - **別のプロセスから、claim の後の処理を当てて、`Pool` を分けたときと同じ結果になった**: S1・S2・S2b・S2c・S3・S9（リース切れの再配達、遅れた側の `complete` の拒否、forget／purge の割り込み）。
  - **contested の対**（逆順・forget との組）は、別のプロセスでも `STALE`・`PAIR-BROKEN` が 0（S4）。
  - `reextract` × `forget`（S5）。
  - 埋め込みは二重にならない（S2）。purge した記憶の埋め込みは残らない（S2 の purge の変種）。
  - 同時の tick は二重 claim しない（S7、障壁つき）。

- **測っていないこと**（未測定。次の巡の入口）:

  - D1 の 0027 の DO ブロック側（`memory_id` の索引）、`runMigrations` が先に落ちる向き。
  - ロックを握った接続が切れたときの `registerEmbeddingSpace`（決定 1 の影響）。
  - D5（ANALYZE の数え）・D6（gate）を複数プロセスで。D7（`decay_clock` の切り替え）。
  - 時計のずれの大きさを変えた測定（D3）。ずれが小さい（リースの半分）ときの二重処理。
  - `restoreSuperseded` × `forget` と `markContestedGroup` の重なりを別のプロセスで（既存の歯は別の `Pool`）。
  - `eraseTenant` どうしの陽性対照（S8）。
  - 別ホスト・ネットワーク越し（ADR 0206・0325 が同じ範囲を未測定と書いている）。
  - SQL_ASCII の DB（この巡は当てていない）、実モデル・実 LLM。
