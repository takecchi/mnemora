# ADR 0307: `aggregateScope` を単一パスの `GROUP BY` に書き換える — 同じ SQL 文・同じ返り値のまま、テナント全体の集計を約1.8倍速くする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

- **文脈**:

  [Issue #355](https://github.com/takecchi/mnemora/issues/355) は、`packages/postgres/src/memory-store.ts`
  の `PostgresMemoryStore.aggregateScope`（`docs/recall.md` §5「スコープの外延」の実装、
  `recall-runtime.ts` の `runRecall()` から**無条件に**呼ばれる）が、1テナント10万行・
  `subjectId` 無し・`digestBand` あり（limit 50・除外10件）で **median 245〜282ms** かかる
  ことを実測で報告した（段1の ANN クエリの約50〜80倍）。`subjectId` で絞った呼び出しは
  同じ条件で 6〜9ms であり、コストは「テナント全体を集計する」経路にだけ在る。

  同 issue は分解も報告している: 素のスキャン 6.7ms → `count(*) FILTER` 群 75〜91ms →
  **`groups`（`GROUP BY subject_id` の別サブクエリ）を足すと 213ms** →
  `digestBand` 込みで 245〜262ms。索引追加・`scoped` CTE の `MATERIALIZED` 化は
  効かなかった（結果が変わらない）と報告されていた。

  読みは2つ:
  1. **`scoped` CTE（`WITH scoped AS (SELECT ... FROM memories WHERE tenant_id = $1 ...)`）が
     本体・`groups` のサブクエリ・`digestBand` のサブクエリの3箇所から参照されており、
     Postgres がこれを実体化する（tuplestore に積み、以後はそこから読む）。**しかも
     `scoped` の projection には `digest`（テキスト列）が含まれ、テナント全件（10万行）の
     digest 本文ごと tuplestore に積まれるため、既定の `work_mem`（4MB）を超えてディスクへ
     溢れる（【実測】後述「測ったこと」）。
  2. **`${x}::timestamptz IS NULL OR ...` 形の述語（`inPeriod`/`isValid` 等）が、
     `count(*) FILTER` の本数（最大10本強）だけ重複して評価されている。**

  **公開 API・返り値・既定挙動を変えずに直せるか**が本 ADR の主題である。
  `ScopeAggregate` は [ADR 0011](./0011-no-window-count-in-ann-stage.md) の系譜——
  「件数はすべて単一の集約クエリから取る」契約（`docs/recall.md` §5、段1から
  `count(*) OVER ()` を締め出したのと同じ理由）——を持ち、`digestBand`（ADR 0073 決定7）・
  `decayed_filtered`（[ADR 0173](./0173-decayed-omission-counted-by-aggregate-scope.md)）は
  いずれも「別クエリにすると別スナップショットになり、被覆不変条件が壊れる」という理由で
  同じ1本の SQL 文に相乗りしている。**この設計そのものは動かさない**——1本の SQL 文の
  ままで、内部の書き方だけを変える。

- **北極星の5つの問いに実際に当てた結果**:

  | 問い                                      | この判断にどう当たったか                                                                                                         | 落ちた案                                                                                                                                      |
  | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | **1**（毎回渡す量を減らす方向に働くか）   | `recall()` のレイテンシを縮めるので、間接的に「使う側が量を選ぶ」判断のコストを下げる。返り値の量そのものは1バイトも変わらない。 | —                                                                                                                                             |
  | **2**（無効にしても成立するか）           | 該当しない——`aggregateScope` は無効化できるオプションを持たない既存の必須経路であり、本 ADR はその実装だけを変える。             | —                                                                                                                                             |
  | **3**（選ばれた理由を後から説明できるか） | **これが本題である。**「なぜ同じ結果なのに速いのか」を、等価性の歯と EXPLAIN の実測で説明する。                                  | 近似カウント・`digestBand` と群カウントを分離する案（下記「採らなかった案」）。どちらも「速い理由」は説明できるが、「同じ結果である」を失う。 |
  | **4**（推論と事実を区別しているか）       | 該当しない——この判断は集計 SQL の書き方の話であり、provenance に触れない。                                                       | —                                                                                                                                             |
  | **5**（LLM を呼ばずに済ませられないか）   | 元から LLM を呼ばない。SQL の書き方と `EXPLAIN` で解く。                                                                         | —                                                                                                                                             |

- **決めたこと**:

  1. **各行の述語を `scoped` CTE の中で1回だけ boolean として計算する。** `live`
     （`status IN ('active','contested')`）・`in_period`・`is_valid`・`is_expired`・
     `is_not_yet_valid`・`is_decayed` の6列を `scoped` の projection に持ち、以後の
     `count(*) FILTER` はこの列を参照するだけにする。**式そのもの
     （`${x}::timestamptz IS NULL OR ...`）は `scoped` の中に1回しか書かない**
     （旧実装は同じ式を最大10本強の `FILTER` に埋め込んでいた）。

  2. **`GROUP BY subject_id` で subject ごとの各カウンタを1パスで出す（`agg` CTE）。**
     `in_scope`・`not_indexed_pending/failed/skipped`・`archived`・`superseded`・
     `forgotten`・`period_filtered`・`expired_filtered`・`not_yet_valid_filtered`・
     `decayed_filtered` の11列を、`scoped` を1回スキャンする `GroupAggregate`/
     `HashAggregate` で同時に出す。**旧実装は「テナント全体のスカラー集計」（1回のスキャン）
     と「`groups` の `GROUP BY` 別サブクエリ」（もう1回のスキャン）を別々に行っていた
     ——本 ADR はこれを1回のスキャンに統合する。**

  3. **外側で `groups`（`in_scope > 0` の subject のみ）と各合計を、`agg` に対する
     1回の `Aggregate` ノードで取る。**
     - `groups` は `json_agg(json_build_object('key', subject_id, 'count', in_scope))
FILTER (WHERE in_scope > 0)`。**現物と同じ集合になる**——現物は
       `GROUP BY` の前に `WHERE <live AND in_period AND is_valid>` を掛けているため、
       in_scope が0の subject はそもそも現れない。新実装は `agg` に全 subject の行が
       在るが、`in_scope > 0` で絞ることで同じ集合になる（「測ったこと」参照、等価性の歯が
       全パターンで検査する）。
     - 各合計は `coalesce(sum(...), 0)::int`。**空テナント（`agg` が0行）でも `NULL` では
       なく現物と同じ `0` を返す**——`sum()` は0行に対して `NULL` を返すため、
       `coalesce` を欠くと空テナントで壊れる（等価性の歯「空テナント」がこれを検査する）。

  4. **`digestBand` は `scoped`/`agg` を経由せず、`memories` を直接（同じ `tenant_id`/
     `subjectFilter` の WHERE で）引く独立したサブクエリにする。**
     - `digests`（`ORDER BY eff_time DESC, id DESC LIMIT digestBand.limit`）は digest 本文が
       要るので、`memories` を直接スキャンし `id, digest, eff_time` だけを投影する
       ——`scoped` に digest 列を持たせて共有する必要が無くなった。
     - `digest_eligible_count` は `scoped`/`memories` を再スキャンしない。**集計側
       （`agg` の `in_scope` 合計）から、`excludeMemoryIds`（高々 `digestBand.limit` 件、
       テナント規模に応じて増えない）に該当する行のうち in_scope 条件を満たす件数を
       引き算して出す。** この補正クエリは `id = ANY(...)` で主キーに乗るので、
       テナント規模に依存しない定数コストである。

  5. **`scoped`・`agg` のどちらにも `MATERIALIZED` を明示しない。** 実際に試して
     測ったが、採らなかった（下記「採らなかった案」3番）。

  6. **`groups` の出現順序は契約にしない**（明記のみで、実装上の変更ではない）。
     旧実装も `json_agg` に `ORDER BY` を持たず、`GROUP BY` の実行順（プラン依存）に
     従っていた。呼び出し側（`packages/core/src/recall-runtime.ts`・`packages/testkit`
     の適合テスト・`packages/postgres` の適合テスト・`examples/chat`）のいずれも
     `groups` の順序に依存していないことを確認済み（下記「確かめたこと」）。

  7. **公開 API・返り値の型・関数シグネチャは1バイトも変えていない。**
     `AggregateScopeOptions`・`RecallScope`・`ScopeAggregate` はいずれも変更していない。

- **同一スナップショットである根拠（なぜ結果が変わらないか）**:

  SQL 文は1本のまま——`this.db.execute(sql\`...\`)`の呼び出しは相変わらず1回だけであり、`packages/postgres/src/**tests**/recall.postgres.test.ts` の「被覆不変条件: aggregateScope は
単一の SQL 往復で完結する（構造的な検査）」が今回も緑のままである（`pool.query` の
呼び出し回数を数える歯。書き換え後も1回）。`digestBand`・`decayed_filtered` を含む
  すべての列が、この1本の SQL 文・1回の往復から取られ続ける——ADR 0011 が求める
  「別々のクエリから出すと、その間の書き込みで総和が一致しなくなる」への対処は動いていない。

  **等価性そのものは、旧実装の SQL をテスト内に固定した参照オラクルとの突き合わせで検査する**
  （下記「等価性の歯」）。

- **測ったこと**:

  ### 実測条件
  - PostgreSQL 17.11 + pgvector 0.8.0（native、`initdb`。docker/podman が無い環境
    ——`AGENTS.md`「手元で Postgres を立てる」手順）。`shared_buffers=512MB`、
    `max_parallel_workers_per_gather=0`、`work_mem` は既定の4MB（GUC は変えていない）。
  - 1テナント（`bench-b`）10万行。埋め込みは触らない（`aggregateScope` はベクトル列を
    見ない）ので合成データで十分——status 4分岐（active 70% / contested 10% /
    archived 8% / superseded 6% / forgotten 6%）・embedding_status 4種・period/valid_from
    /valid_until/decay_floor_at をランダムに分散。中規模 subject（2,000行）を1つ含む。
  - **`new PostgresMemoryStore(db).aggregateScope()` を TypeScript から実際に呼んで測った**
    （SQL の書き写しではない）。書き換え前 (`dist-old`) と書き換え後 (`dist-new`) を
    同じプロセス・同じ `pg.Pool`・同じ接続・同じデータに対して**交互実行**
    （old→new→old→new…）し、各25回、直前に1回ずつ warm-up した。
  - `digestBand`（limit 50・除外10件）あり。`occurredAfter`/`occurredBefore`/`validAt`/
    `decayFloorAtAfter` を指定（Issue #355 の実測条件を踏襲）。

  ### `subjectId` 無し（テナント全体）

  |            |  median |    mean |     p10 |     p90 |     p95 |
  | ---------- | ------: | ------: | ------: | ------: | ------: |
  | 書き換え前 | 281.2ms | 292.3ms | 246.7ms | 347.2ms | 400.4ms |
  | 書き換え後 | 156.0ms | 160.0ms | 140.2ms | 186.7ms | 190.5ms |

  ⟹ **median で約1.8倍（-44.5%）。**

  ### `subjectId` あり（中規模 subject、2,000行）

  |            | median |   mean |    p10 |    p90 |     p95 |
  | ---------- | -----: | -----: | -----: | -----: | ------: |
  | 書き換え前 | 8.53ms | 8.53ms | 7.30ms | 9.49ms | 10.54ms |
  | 書き換え後 | 6.69ms | 7.24ms | 5.85ms | 9.66ms | 10.58ms |

  ⟹ **約22%減。**この経路は元々遅くなかった（Issue #355 も「コストはテナント全体の
  集計に在る」と報告している）ため、絶対値としての伸びしろは小さい。

  ### `EXPLAIN (ANALYZE, BUFFERS)`（`subjectId` 無し・digestBand 込み、代表的な1回）

  **書き換え前**（Execution Time **284.7ms**）:

  ```
  Aggregate  (actual time=281.314..281.318 rows=1 loops=1)
    Buffers: shared hit=3331, temp read=2736 written=1368
    CTE scoped
      ->  Seq Scan on memories  (actual time=0.013..... rows=100000)
    InitPlan 2 (groups)
      ->  Aggregate → GroupAggregate → Sort → CTE Scan on scoped scoped_1 (rows=28882)
    InitPlan 3 (digestBand)
      ->  Aggregate → Limit → Sort → CTE Scan on scoped scoped_2 (rows=28872)
    ->  CTE Scan on scoped  (rows=100000)
          Buffers: shared hit=3331, temp written=1367
  ```

  `CTE Scan on scoped` が**3箇所**に現れ、`temp read=2736 written=1368`——`scoped`
  （digest 込みの広い行、10万行）が `work_mem` を超えてディスクへ溢れている。

  **書き換え後**（Execution Time **165.1ms**）:

  ```
  Aggregate  (actual time=164.941..164.947 rows=1 loops=1)
    Buffers: shared hit=6954
    InitPlan 1 (digests: memories を直接)
      ->  Aggregate → Limit → Sort → Bitmap Heap Scan on memories memories_1 (rows=28872)
    InitPlan 2 (digest_eligible_count の補正: memories_pkey)
      ->  Aggregate → Bitmap Heap Scan on memories memories_2 (rows=10, memories_pkey に乗る)
    ->  HashAggregate  (Group Key: memories.subject_id, rows=982)
          ->  Seq Scan on memories  (rows=100000)
  ```

  **`CTE Scan` が1つも現れない**（`scoped`・`agg` とも参照が1回ずつなので Postgres が
  インライン化する）。`temp` が一切現れない——ディスクへの溢れが消えた。
  `digestBand` の2つのサブクエリ（`digests`・`digest_eligible_count` の補正）は
  `memories` を直接引き、後者は `memories_pkey` に乗って実質定数コストになっている。

  ### 支配項は今も「`GROUP BY subject_id` の1パス」である

  書き換え後の内訳（上の EXPLAIN）: `digests` のサブクエリが約30ms、`digest_eligible_count`
  の補正が1ms未満、残り約133ms（165ms中）が `HashAggregate`（`Group Key:
memories.subject_id`、10万行の `Seq Scan` を含む）に掛かっている。**これは旧実装の
  「`groups` を足すと213ms」の後継であり、10万行を `GROUP BY subject_id` で束ねる
  コストそのものは消えていない**——本 ADR が消したのは「3回読む」「digest を持ち回る」
  「述語を重複評価する」の3つであって、「10万行を1回読んで集計する」コストそのものではない。

- **等価性の歯**:

  `packages/postgres/src/__tests__/aggregate-scope-single-pass.postgres.test.ts` を新設した。

  - **`oracleAggregateScope`** という関数を、本 ADR が分岐した時点
    （`f3b3516`）の `PostgresMemoryStore.aggregateScope` の SQL をそのまま書き写して
    テスト内に固定する（⛔ この関数は書き換えない——「旧実装が何を返していたか」の
    記録として、新実装の変更から独立に保つ）。
  - 17個の `it()` で、以下の組合せを踏むデータに対して、新実装 (`memoryStore.aggregateScope`)
    と `oracleAggregateScope` の返り値が**完全一致**することを検査する:
    `subjectId` 無し／有り／存在しない subject・`includeSubjectless`（NULL subject を含む）・
    `occurredAfter`/`occurredBefore`（period）・`validAt`（expired/not_yet_valid）・
    `decayFloorAtAfter`（壁時計）・`decayFloorSeqAfter`（活動時計、NULL floor の素通し）・
    `decayFloorAnyAxis`（OR/AND の両方）・`digestBand` 有無・除外 id 有無（空配列を含む）・
    `digestBand.limit` が資格件数より小さいケース・空テナント・digest の同時刻 tie
    （`occurred_at` が同一の2件を仕込み、`ORDER BY eff_time DESC, id DESC` の
    タイブレークが一致することを確認）・複数条件の組合せ。
  - `groups` は順序を無視して（`key` でソートしてから）比較し、`digests` は
    決定的な順序そのものが契約なので配列全体を順序込みで比較する
    （`expectSameAggregate` ヘルパー）。
  - 被覆不変条件（`groups` の総和 == `totalInScope`）の並行書き込み検査
    （既存の `recall.postgres.test.ts` の歯と同型）も新実装に対して再確認した。

  **構造的な歯**: 「digestBand 込みでも `scoped`/`agg` を実体化しない（`CTE Scan` が無い）」
  ——`captureClientQuery`/`explainCaptured`（`test-db.ts`、ADR 0284 の手法）で
  `aggregateScope` が実際に発行する SQL を捕まえ、`EXPLAIN` して `CTE Scan` が
  1つも現れないことを検査する。

  **赤→緑を実際に記録した**（`docs/autonomy.md`/`AGENTS.md`「`cp` で退避し `cp` で戻す」
  手順）: `memory-store.ts` を分岐点（`f3b3516`）の内容へ一時的に戻し、この構造的な歯だけを
  走らせたところ、期待どおり**赤**になった——

  ```
  AssertionError: expected 'Aggregate ...' not to match /CTE Scan/
  + Received: "... CTE Scan on scoped scoped_1 ... CTE Scan on scoped scoped_2 ... CTE Scan on scoped ..."
  ```

  （`CTE Scan on scoped` が3箇所。他の16個の等価性の歯は「旧実装 vs 旧実装（=oracle）」に
  なるため自明に緑のまま——これは想定どおりで、赤くなるべきなのは構造的な歯だけである。）
  `memory-store.ts` を新実装へ戻すと、17個すべてが**緑**に戻った。`git status --porcelain`
  で退避が過不足なく戻ったことも確認した。

  既存の関連する歯（`recall.postgres.test.ts` の「aggregateScope は単一の SQL 往復で
  完結する」「並行して書き込みが起きている最中でも groups の総和 == totalInScope が
  崩れない」、`packages/testkit` の conformance を postgres に当てたテストのうち
  `aggregateScope` 関連32件）もすべて緑のまま。

- **確かめたこと（`groups` の順序）**:

  `groups` の出現順序に呼び出し側が依存していないことを、以下を実際に読んで確認した:
  - `packages/core/src/recall.ts` の `ScopeAggregate.groups`・`GroupCount` の doc コメントは
    総和の一致（被覆不変条件）にのみ言及し、順序には触れていない。
  - `packages/core/src/recall-runtime.ts` は `aggregate.groups` を `IndexBand.groups` へ
    そのまま代入するだけで、ソートも先頭N件抽出もしない。
  - `packages/testkit/src/memory-store-conformance.ts` の `aggregateScope`/`groups` に
    関するテストは、`Map` でキー引きする・`reduce` で総和を見る・`toContainEqual`
    （部分集合としての存在検査）で検証しており、配列全体を順序込みで比較している箇所は無い。
  - `packages/postgres/src/__tests__/recall.postgres.test.ts` の `groups` 関連の歯も
    総和のみを見る。
  - `examples/chat` は `groups.length`（件数）だけを使い、要素の順序を利用していない。

  ⟹ **`groups` の順序を不定のまま書き換えても、既存の呼び出し側・テストを壊す実害は無い。**

- **採らなかった案**:

  1. **索引を追加する**（Issue #355「対処の方向」）。`scoped` の `WHERE tenant_id = $1`
     は既に `idx_memories_recall_gate` 等でカバーされており、支配項は「テナント全件を
     `GROUP BY subject_id` で束ねる」ことそのものであって、索引で避けられるスキャンでは
     ない（Issue #355 の実測でも「索引追加・MATERIALIZED 化は効かなかった」と報告済み。
     本 ADR も新しい索引を追加していない）。

  2. **`digestBand` と群カウントを別クエリに分ける**（Issue #355「対処の方向」）。
     ADR 0011・ADR 0073 決定7・ADR 0173 がいずれも「別クエリにすると別スナップショットに
     なり、被覆不変条件が崩れる」という理由でこれを退けている。**本 ADR も同じ理由で
     退ける**——1本の SQL 文のまま書き換える、という PR の縛りそのものである。

  3. **`scoped` CTE に `MATERIALIZED` を明示する。実際に試して測った。**
     `scoped` は digest を持たない狭い行（boolean 6列 + `status`/`embedding_status`/
     `subject_id`）だが、10万行では既定の `work_mem`（4MB。GUC はアプリの既定を
     変えるので変えない前提）を超え、実体化そのものがディスクへ溢れた
     （`EXPLAIN` に `temp written` が再発）。インライン化のまま述語を複数回
     再評価するコストのほうが、たとえ狭い行でも `work_mem` を超えたディスクへの
     実体化より安かった——【実測】インライン化 156〜165ms 台 vs `MATERIALIZED`
     204〜254ms 台（同じデータ・同じ器）。**述語自体（`timestamptz` の比較数個）が
     軽いため、行数分の重複評価は、ディスク書き込みが1回でも発生するコストに勝てない。**

  4. **近似カウント**（`docs/recall.md` §5 が設計の意図として書きつつ Phase 1 では
     実装していない経路。[ADR 0024](./0024-remove-exact-counts-option.md) が
     `exactCounts` オプションを削除済み）。**この PR の射程外**——`countKind` を
     `'exact'` から動かす判断は別の ADR の仕事であり、混ぜない
     （`docs/autonomy.md` §2「1つの PR は1つの ADR とその実装」）。

  5. **`work_mem` を上げる（GUC のチューニング）。** マネージャー指示により、
     アプリの既定を変える調整は採らない対象として明示されている。加えて、
     `work_mem` はセッション/接続ごとの GUC であり、`aggregateScope` 単体のために
     恒久的に上げると、同じ接続で走る他のクエリのメモリ使用量にも影響する
     （調べていない副作用まで引き受けることになる）。

- **引き受けた負債**:

  1. **支配項（`GROUP BY subject_id` で10万行を束ねる1パス）は消えていない。**
     書き換え後の EXPLAIN でも `HashAggregate` に約133ms（全体165ms中）が掛かっている。
     本 ADR が消したのは「3回読む」「digest を持ち回る」「述語を重複評価する」の3つで
     あって、「テナント全体を1回集計する」コストの本体ではない。**1M行では測っていない**
     （下記「確かめていないこと」）——このコストが規模とともにどう伸びるかは未検証。

  2. **`digests` サブクエリ（top-N）は今も `memories` を tenant_id で絞ったうえで
     ソートしており、`occurred_at`/`recorded_at` に有効な索引が無い限り、in-scope 件数
     （本測定では約29,000行）ぶんのソートを避けられない。** 本 ADR の範囲では
     この部分の追加最適化（式索引の追加など）を行っていない——「索引を足さない」
     という PR の前提（マネージャー指示）に従う。

  3. **`groups` の順序が今日も不定である、という事実そのものは変えていない。**
     「確かめたこと」で依存が無いことを確認したが、`ScopeAggregate.groups`/`GroupCount`
     の doc コメントに「順序は不定」という明文の宣言を足すところまでは、本 PR の
     コード変更（`memory-store.ts` の doc コメント）で行ったが、`packages/core`
     側の型 doc への追記は行っていない（`packages/core` は本 PR の変更対象外——
     `packages/postgres` の実装だけを直す、という Issue #355 の射程に従う）。

- **これが覆るとしたら**:

  1. **1M行規模で、`HashAggregate` 本体のコストが実運用上「割に合わない」と
     判断されたとき。** そのときは「採らなかった案」4番（近似カウント）か、
     `digestBand`/群カウントを分離する判断（別スナップショット化を受け入れる、
     ADR 0011 の見直しを伴う）が候補になる——どちらも本 ADR の射程外であり、
     別の ADR の仕事である。

  2. **`groups` の順序に依存する呼び出し側が新設されたとき。** 「確かめたこと」は
     2026-09-25 時点の repo 全体を読んだ結果であり、将来のコードがこの前提を
     破らない保証はない——`ScopeAggregate.groups` の doc コメントに明文の宣言が
     無い限り、同じ調査をやり直す必要がある（引き受けた負債3番）。

  3. **`work_mem` の既定がプロジェクト全体の判断として引き上げられたとき。**
     そのときは「採らなかった案」3番（`scoped` の `MATERIALIZED` 化）を再検討する
     価値がある——本 ADR が測った「`MATERIALIZED` は遅い」という結果は、
     既定 `work_mem=4MB` という前提の上でのものである。

- **確かめていないこと**:

  - **1,000,000行では測っていない**（`docs/recall.md` §5 の既存の実測では
    テナント全体が1Mで408ms とされているが、本 ADR ではその規模の書き換え後の値を
    測っていない）。
  - **cold cache では測っていない**（すべて `shared_buffers` に載る温かい条件）。
  - **並列実行（`max_parallel_workers_per_gather` > 0）を有効にした場合は測っていない。**
  - **CI が使う `pgvector/pgvector:pg17` と同一環境であることは確認していない**
    （native の PostgreSQL 17.11 + pgvector 0.8.0 で測った）。
  - **同時実行下（複数コネクションが同時に `aggregateScope` を呼ぶ場合）は測っていない**
    （単発呼び出しの交互実行のみ）。
  - **`decayFloorSeqAfter`/`includeSubjectless` を伴うテナント全体呼び出しの latency は
    個別に測っていない**（等価性は歯で検査したが、benchmark の対象は基本の条件
    （`occurredAfter`/`occurredBefore`/`validAt`/`decayFloorAtAfter`のみ）に限る）。
  - 実運用で `aggregateScope` が実際にどの述語の組合せで最も多く呼ばれるかは、
    このリポジトリの中には根拠が無い（`docs/recall.md` §5 の既存の限定と同じ）。
