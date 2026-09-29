# ADR 0384: `aggregateScope` の重さに対して、目次帯へ部分索引を足す（案A）と、件数集計を止める明示的な opt-in を足す（案C）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

- **文脈**:

  `packages/core/src/recall-runtime.ts` の段5（`MemoryStore.aggregateScope`、
  `docs/recall.md` §5「スコープの外延」）は、`recall()` のたびに**条件なしで**呼ばれる。
  [ADR 0307](./0307-aggregate-scope-single-pass.md) が単一パス化して10万行で
  281.2ms→156.0ms（約1.8倍）に縮めたが、同 ADR「引き受けた負債」1番・2番は
  次の2つを未解決のまま引き継いでいる:

  1. **支配項（`GROUP BY subject_id` でテナント全件を束ねる本体、`agg` CTE）は消えていない。**
     ADR 0307 は1M行では測っていなかった。
  2. **目次帯（`digestBand`）の `ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC
     LIMIT n` に支える索引が無く、in-scope 件数ぶんの `Seq Scan` + top-N `Sort` を
     毎回行っている。**

  マネージャーの前段の測定（`/tmp/mgr-6c225812-bench/results.md`）が、100万行・
  `max_parallel_workers_per_gather=0`・同時1・非active比率0%・warm で全体
  **2047ms**、うち①件数集計（`HashAggregate`）が**1359ms**、②`digestBand`
  （`Seq Scan` + top-N `Sort`）が**646ms**であることを実測している。

  本 ADR は、①と②に別々の手当てをする:

  - **案A**（本 ADR、非破壊）: ②を部分索引で塞ぐ。
  - **案C**（本 ADR、追加のみ・非破壊）: ①を、呼び出し側が明示的に選んだときだけ止める
    opt-in を足す。

- **北極星の5つの問いに実際に当てた結果**:

  | 問い | 案A | 案C |
  | --- | --- | --- |
  | **1**（毎回渡す量を減らす方向に働くか） | `recall()` のレイテンシを縮める。返り値は1バイトも変わらない。 | `"skip"` を選んだ呼び出しだけレイテンシが劇的に縮む（後述）。既定は変わらない。 |
  | **2**（無効にしても成立するか） | 該当しない——`aggregateScope` の必須経路の実装だけを変える。 | **該当する。** `scopeAggregate` を渡さない呼び出しは今日どおり動く——この opt-in 自体が「無くても Memory Framework として成立する」ことの実例である。 |
  | **3**（選ばれた理由を後から説明できるか） | 同じ結果を返すことを等価性の歯と EXPLAIN で示す——「なぜ速いか」を実装が語れる。 | **これが `"skip"` の代償である**——件数集計を止めると `omitted` の `filtered*` が一切積まれなくなり、「何が落ちたか」を説明できなくなる。`countKind: 'unknown'` がその事実を正直に名乗る（ADR 0008 の系譜）。 |
  | **4**（推論と事実を区別しているか） | 該当しない。 | 該当しない。 |
  | **5**（LLM を呼ばずに済ませられないか） | 元から LLM を呼ばない。索引と `EXPLAIN` で解く。 | 同上。 |

- **決めたこと**:

  ## 案A: `idx_memories_digest_band` 部分索引

  1. **`(tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC) WHERE status IN
     ('active', 'contested')` の部分索引を足す**（`packages/postgres/migrations/0027_digest_band_index.sql`）。
     - `status IN (...)` を索引の**列**ではなく**部分述語**にする——複数値の等値条件を
       列に含めると、B-tree は値ごとに別々の範囲になり `ORDER BY <expr> DESC, id DESC`
       の全順序を1本のスキャンでは提供できない（値ごとの結果をマージする必要があり、
       `LIMIT` で早期終了できなくなる）。部分述語にすれば、索引そのものが
       「対象行だけを `eff_time DESC, id DESC` の順に並べたリスト」になる。
     - `id DESC` を2列目に置き、`digestBandColumns` の `ORDER BY` と1バイトも
       違わない形に揃える（tie-break の一致）。
  2. **SQL 文自体は変えていない**——`memory-store.ts` の `digestBandColumns` は
     ADR 0307 時点のクエリのまま。索引を追加しただけで、返す digest の中身・順序・
     件数は1バイトも変わらない（等価性はこの索引の追加が新しい分岐を作らないことから
     自明——歯は「新しい索引が実際に使われること」だけを見ればよい）。
  3. **`occurredAfter`/`occurredBefore`/`validAt`/`labels` を指定しない既定の呼び出し**
     （`in_period`/`is_valid`/`has_qualifying_label` が定数 `true` になる）**では、
     索引だけで `LIMIT` まで打ち切れる**——`Index Scan`（`tenant_id` の等値条件のみ）
     + `Limit`。指定した呼び出しではこれらが `Filter` として残るが、`tenant_id` の
     絞り込み自体は索引が効く。
  4. **`subjectId` 絞りには専用の複合索引を足さない。** ADR 0307 の実測で
     `subjectId` ありの呼び出しは既に軽い（10万行・中規模 subject で 6.9ms 台）——
     支配項はテナント全体の集計であって、subject 単位の digestBand ではない。
     今回の実測（後述「測ったこと」）でも、`subjectId` 絞りの digestBand は
     プランナが（対象行が少ないため）索引を使わず `Seq Scan` を選ぶことがあったが、
     実行時間自体は 1ms 未満に収まっており、実害は無い。

  ## 案C: `RecallQuery.scopeAggregate: "exact" | "skip"`

  1. **`RecallQuery`（`packages/core/src/recall.ts`）に `scopeAggregate?: "exact" |
     "skip"` を足す。既定は省略時と同じ `"exact"`——1バイトも変わらない。**
     `recall-runtime.ts` は `validatedQuery.scopeAggregate ?? "exact"` を
     `AggregateScopeOptions.scopeAggregate` へそのまま渡すだけで、値の解釈・変換は
     `MemoryStore` 実装の仕事である。
  2. **`AggregateScopeOptions`（`packages/core/src/interfaces/memory-store.ts`）に
     同じ形の `scopeAggregate?: "exact" | "skip"` を足す。** `digestBand?`（既存の欄）
     とは非対称な設計にした——
     - `digestBand?` は「渡さないことが意味を持つ」（省略 = 帯を組まない、渡す adapter
       だけが追加の仕事をする）。
     - `scopeAggregate?` は「**読まれなかったときの安全側が定義されている**」——
       この欄を実装しない adapter（`opts.scopeAggregate` を一切見ない）は、**常に
       厳密集計し `countKind: 'exact'` を返し続けなければならない**契約にした。
       無視されても値の意味は壊れない。呼び出し側は返ってきた `countKind` を見れば、
       その adapter がこの opt-in に対応しているかどうかを常に判別できる——
       「`"skip"` を頼んだのに `"exact"` が返る」ことはあっても、「`"skip"` を
       頼んだのに実は集計していないのに `countKind: 'exact'` の顔で返す」ことは
       契約上起きない。
     - [ADR 0024](./0024-remove-exact-counts-option.md) の事故——`exactCounts` を
       受け取って**黙って無視し**、しかも `countKind` は常にリテラル `'exact'` を
       返し続けていた（「頼んだのに、頼んだこと自体が読めない」二重の嘘）——を
       繰り返さないための設計判断がこれである。ADR 0024 と違うのは、**この欄は
       無視されても嘘をつかない**という一点であり、この一点のために
       「実装しない adapter は `'exact'` を返し続ける」という契約を明文化した。
  3. **`"skip"` を渡された実装（Postgres）は、実際に集計をしない。** 値だけ受け取って
     計算は今までどおり行い、返り値だけを差し替える実装は禁止する
     （`AggregateScopeOptions.scopeAggregate` の doc コメントに明記）——`"skip"` の
     目的は「費用の掛かる集計を止めること」であり、費用を払ったまま値を隠す実装は
     その目的を満たさない。`packages/postgres` の実装は、`"skip"` のとき
     `scoped`/`flags`/`agg` の集計クエリ（支配項）そのものを SQL テキストに含めない
     ——`digestBand` が指定されていれば、それだけ独立した `SELECT`（案A の索引が
     支える）で digest を引く。
  4. **`"skip"` のとき、群カウント・`totalInScope`・`filtered*`・`notIndexed` の
     `countKind` はすべて `'unknown'`、値は `0`/空になる。** `digestBand` は
     集計とは独立した経路なので、`"skip"` でも今日どおり出る——ただし
     `digestEligible`（帯の外にあと何件あるか）は件数の一種なので、`digestBand` を
     指定したときだけ `{ count: 0, countKind: 'unknown' }` になる（`digestBand` を
     指定しない呼び出しは、既存の契約どおり `{ count: 0, countKind: 'exact' }` の
     ままにした——「集計」自体そもそも起きないケースまで `'unknown'` にする理由が
     無い）。
  5. **`taxonomyGroupCandidates` が同時に指定されていても、taxonomy 群カウントも
     計算しない**（`groups` は `axis: 'subject'` も `axis: 'taxonomy'` も空のまま）
     ——`scopeAggregate: "skip"` は「件数集計を止める」という1つの意味であり、
     軸ごとに部分的に効かせる形は採らない。
  6. **`recall-runtime.ts` の `explain.stages`（`index_band`）の `detail` には
     `scopeAggregate` を足さない。** 一度足して、`recall-channels.test.ts`
     「既定(channels 未指定)は ADR 0084 以前と1バイトも変わらない」という
     `RecallResult` 全体の JSON 一致テストが赤くなった（`detail` に新しいキーが
     増えると、既定の出力自体が変わってしまうため）。**マネージャー決定「既定は
     "exact" で、今と1ビットも変わらないこと」を、`explain.stages` を含めて厳密に
     守る**——"skip" が効いたかどうかは `IndexBand.countKind`（`'unknown'`）と
     `IndexBand.totalInScope`（`0`）で読み解ける。

- **測ったこと**:

  ### 実測条件

  - PostgreSQL 17.11（native、`initdb`）、`max_parallel_workers_per_gather=0`
    （接続オプションで固定）、同時実行数1、非active比率0%（全件 `active`）、warm。
  - **案A は SQL 文を変えていない**ため、「前」を再現するのに main ブランチの
    別ビルドは用意しなかった——**同じコード（このブランチの `PostgresMemoryStore`）
    のまま、索引の有無だけを違えた2つの DB**
    （`mnemora_agg_1000000_idx`＝このブランチの migrate をそのまま適用、
    `mnemora_agg_1000000_noidx`＝ `idx_memories_digest_band` だけを `DROP INDEX` した
    もの）を、同一プロセス内で `noidx → idx` の順に ABAB 交互実行した
    （8ラウンド、各ラウンド warmup 1回 + measured 3回、n=24）。同じデータ・同じ
    コード・同じ器で、変数を1つ（索引の有無）だけ動かした形——ADR 0307 の
    「dist-old/dist-new を交互実行」と同じ考え方を、コード差分がゼロな分、より
    単純化したものである。

  ### 案A: 100万行・warm・parallel=0・conc=1（交互, n=24）

  |            |    p50 |    p95 |         min/max |
  | ---------- | -----: | -----: | ---------------: |
  | 前（索引なし） | 1652.6ms | 1889.4ms | 1428.4 / 2029.4 |
  | 後（索引あり） | 1211.6ms | 1445.6ms | 1106.3 / 1510.1 |

  ⟹ **p50 で約27%減（約1.36倍速）。**

  ### 案C: 100万行・warm・parallel=0・conc=1・`scopeAggregate: "skip"`（索引あり DB, n=24）

  |                    |   p50 |  p95 |     min/max |
  | ------------------ | ----: | ---: | ----------: |
  | 後（索引あり・skip） | 1.2ms | 3.4ms | 0.8 / 12.0 |

  ⟹ 「前（索引なし・exact）」比で**約1,377倍**、「後（索引あり・exact）」比で
  **約1,010倍**——件数集計（支配項）を止めると、100万行でも1桁 ms に収まる
  （digestBand だけを索引経由で引くコストのみが残る）。

  ### 案A: 10万行・cold/warm-after・parallel=0・conc=1（前後それぞれ2ラウンド）

  「cold」の近似は前段と同じ——**root 権限が無く `/proc/sys/vm/drop_caches` へ
  書けないため、OS ページキャッシュは落とせていない。「cold」は自分専用 Postgres
  インスタンスの再起動のみ（`shared_buffers` を空にする）。** 1ラウンドにつき
  cold 5回・warm-after 15回、`noidx`→`idx` の順に `pg_ctl restart` を挟んで
  2ラウンド（cold n=10、warm-after n=30）。

  |            |    cache |   p50 |   p95 |        min/max |
  | ---------- | -------- | ----: | ----: | --------------: |
  | 前（索引なし） | cold        | 134.0ms | 195.6ms | 111.9 / 208.7 |
  | 前（索引なし） | warm-after  | 110.8ms | 129.5ms |  99.1 / 142.0 |
  | 後（索引あり） | cold        |  82.4ms | 140.9ms |  64.6 / 141.8 |
  | 後（索引あり） | warm-after  |  77.6ms | 101.9ms |  66.1 / 109.0 |

  ⟹ **10万行では、前・後とも 200ms を安定して超えなかった**（p95 の最大は前側
  cold の195.6ms。個別サンプルでは前側 cold に208.7ms が1つあったが、n=10と
  少ないためこのばらつきをそのまま受け取る）。**索引の効果は cold/warm-after
  どちらでも一貫して見える**（cold: 134.0→82.4ms、warm-after: 110.8→77.6ms、
  どちらも約25〜30%減）。

  ### EXPLAIN（100万行、warm、parallel=0、digestBand込み、強制なし）

  **前（索引なし）**: Execution Time **1676.730ms**

  ```
  Aggregate (actual time=1671.580..1671.584 rows=1 loops=1)
    Buffers: shared hit=160 read=68806
    InitPlan 1 (digests)
      -> Limit -> Sort(top-N heapsort) -> Seq Scan on memories
         (actual rows=1000000) -- actual 542.648ms, Buffers: shared hit=96 read=34387
    -> HashAggregate (Group Key: subject_id, actual 1098.444..1107.797ms)
       -> Seq Scan on memories (actual rows=1000000)
  ```

  **後（索引あり）**: Execution Time **1305.641ms**

  ```
  Aggregate (actual time=1304.528..1304.531 rows=1 loops=1)
    Buffers: shared hit=135 read=34401
    InitPlan 1 (digests)
      -> Limit -> Index Scan using idx_memories_digest_band
         (Index Cond: tenant_id = ..., actual rows=50) -- actual 0.121ms, Buffers: shared hit=53
    -> HashAggregate (Group Key: subject_id, actual 1271.244..1281.348ms)
       -> Seq Scan on memories (actual rows=1000000)
  ```

  ⟹ **digests 側は 542.6ms → 0.12ms（約4,500倍）、ディスク読み込みも消えた
  （`read=34387` → 0）。** 全体の短縮幅（1676.7ms → 1305.6ms）は、ほぼこの
  digests 側の削減と総バッファアクセスの減少（`read=68806` → `read=34401`）で
  説明がつく。**本体の `HashAggregate`（支配項）は前後でほぼ同じ**
  （1098〜1108ms → 1271〜1281ms、実行ごとの揺れの範囲）——**案A はここに効かない
  設計であり、そのとおりの結果になっている。**

  詳細な生データ・EXPLAIN 全文は `/tmp/mgr-6c225812-bench/results-stage2.md` および
  同ディレクトリの `explain-1m-before-after.log`・`cold-warm-results.jsonl` に在る
  （bench 用の使い捨て器なので commit しない）。

- **等価性・構造の歯**:

  - 案A: `packages/postgres/src/__tests__/digest-band-index.postgres.test.ts`
    （形・本番 SQL の EXPLAIN・同値の3本）。索引の部分述語・列順を壊す変異、
    索引そのものを外す変異の両方で赤くなることを確認した。
  - 案C: `packages/testkit/src/memory-store-conformance.ts` の `aggregateScope`
    セクションに追加した4本（既定/`"exact"` 明示の一致、`"skip"` の形、
    `digestBand` 省略時の `digestEligible` 契約維持、`countScopeAggregateQueries`
    フックによる「`"skip"` は `GROUP BY subject_id` を含む SQL を実際に発行しない」
    検査）。Postgres・in-memory の両実装に変異（skip 分岐を無効化する／
    `skipCounting` を `false` に固定する）を当てて赤くなることを確認した。

- **採らなかった案**:

  1. **案B: 件数を N 行で打ち切って `lower_bound` を返す。** `count(*) FILTER`
     に `LIMIT` 相当の早期終了は無く、Postgres の集約は最後まで数えないと
     `lower_bound` の意味のある下限を作れない（`count(*) FILTER (WHERE ...)
     LIMIT N` という構文は存在しない——打ち切るには、別途 `LIMIT` 付きの
     サブクエリで「N 件見つかったら数えるのをやめる」ようなクエリ書き換えが
     要る）。**この N をいくつにするかはオーナーが決める閾値であり、本 ADR の
     範囲では決めない**——保留。`CountKind.lower_bound` 自体は既に型として
     在る（`packages/core/src/recall.ts`）ので、将来この案を採るときに型の
     変更は要らない。
  2. **事前カウンタ表**（`subject_id` ごとの件数をトリガ/別ジョブで先に集計して
     おく表）。**`is_expired`/`is_decayed`/期間外（`inPeriod`/`isValid`）は
     recall 実行時刻（`validAt`/`decayFloorAtAfter` 等）に依存する述語であり、
     recall のたびに変わる**——「いま何件が期限切れか」「いま何件が減衰しきったか」
     は事前に数えておくことができない（数えた瞬間から時刻が進めば値が古くなる）。
     `status`（`archived`/`superseded`/`forgotten`）のようにトリガで維持できる
     カウンタと、`validAt`/`decayFloorAtAfter` のように呼び出しごとに変わる
     カウンタが同じ集約の中に混在しているため、**表を割っても集約全体を
     1回のスキャンで済ませる今の設計より速くなる保証が無く**、逆に「カウンタ
     表と実データがいつ食い違うか」という新しい正しさの問題を持ち込む。
     `packages/core` 側にこの手当てをする実装は無い。

  3. **索引を追加してテナント全体の `HashAggregate`（本体、支配項）自体を
     速くする**（ADR 0307「採らなかった案」1番と同じ理由で却下）。`tenant_id`
     の絞り込みは既に `idx_memories_recall_gate` 等でカバーされており、
     支配項は「テナント全件を `GROUP BY subject_id` で束ねる」ことそのもので
     あって、索引で避けられるスキャンではない。**本 ADR の案A が対象にするのは
     `digestBand` 側のソートだけであり、本体はそもそも対象外**（測ったことの
     EXPLAIN が示すとおり）。

- **引き受けた負債**:

  1. **本体の `HashAggregate`（支配項）は今回も消えていない。** 1M行で
     1098〜1281ms 掛かったままである——本 ADR が縮めたのは digestBand 側
     （542.6ms→0.12ms）だけであり、`recall()` を条件なしで重くしている
     最大の要因は依然として残っている。この負債を消すには「採らなかった案」
     1・2（近似カウント・事前カウンタ表）のどちらかを、実際に測ったうえで
     採る判断が要る——それは本 ADR の範囲外である（案C の `"skip"` は
     「止める」選択肢を用意しただけで、既定の挙動を変えていない）。
  2. **`"skip"` を使うと `omitted` の `filtered*` が一切報告されなくなる**
     ——「使われない記憶が静かに遠ざかる」ことの説明力（北極星「目指す姿」）を
     手放す取引である。呼び出し側がこの取引を意図して選べるよう、
     `RecallQuery.scopeAggregate` の doc コメントに明記した。
  3. **`subjectId` 絞りの digestBand に専用索引を足していない。** 今回の
     規模（10万〜100万行、中〜大規模 subject）では実害が見えなかったが、
     非常に skew した分布（1つの subject が数十万行を持つ等）では、
     `tenant_id, subject_id` の複合索引が要る可能性がある——測っていない。

- **これが覆るとしたら**:

  1. **本体の `HashAggregate`（支配項）のコストが実運用上「割に合わない」と
     判断されたとき**——ADR 0307「これが覆るとしたら」1番と同じ状況。
     そのときは「採らなかった案」1番（近似カウント、N の閾値をオーナーが決める）
     か、2番（事前カウンタ表、ただし recall 時刻に依存する述語群の扱いを
     別途決める必要がある）を、実測のうえで採る。
  2. **`subjectId` 絞りの digestBand が、非常に skew した分布のテナントで
     支配項になると分かったとき**——「引き受けた負債」3番の専用索引を検討する。
  3. **`"skip"` を選んだ呼び出しが増え、`omitted.filtered*` の欠落が実運用で
     問題になったとき**——「段階的な集計」（例: `filtered*` だけ数えて
     `groups`/`totalInScope` は数えない、のような中間状態）を追加する判断が
     要る。今回は「全部数える」か「全部止める」の二択のみを用意した——
     中間状態は測る前に足すと ADR 0011 の `count(*) OVER ()` と同じ事故に
     なるため、**いまは決めない**。

- **確かめていないこと**:

  - **300万行規模での案A・案Cの効果は測っていない**（前段のベンチは
    300万行まで測っているが、本 ADR の前後測定は100万行・10万行に限る）。
  - **並列実行（`max_parallel_workers_per_gather` > 0）を有効にした場合の
    案A・案Cの効果は測っていない**——前段のベンチでは並列既定(2)が本体・
    digestBand 側の両方に効くことが分かっているが、本 ADR の前後比較は
    `parallel=0` に固定した条件でのみ行った。
  - **同時実行下（複数コネクションが同時に呼ぶ場合）の案A・案Cの効果は
    測っていない**——単発呼び出しの交互実行のみ。
  - **真の cold cache（OS ページキャッシュも空）では測っていない**——
    「Postgres 再起動のみ」という限定的な近似にとどまる。
  - **`subjectId` 絞り・`decayFloorSeqUsesSubjectCounters`・taxonomy
    群カウントを伴う呼び出しの、案A・案C適用後のレイテンシは個別に測って
    いない**——等価性は歯で検査したが、benchmark の対象は基本条件
    （`subjectId` 無し・digestBand あり・`occurredAfter`/`occurredBefore`/
    `validAt` 無し）に限る。
  - **CI が使う `pgvector/pgvector:pg17` と同一環境であることは確認していない**
    （native の PostgreSQL 17.11 + pgvector で測った、ADR 0307 と同じ限定）。
