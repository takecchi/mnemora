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

  100万行・`max_parallel_workers_per_gather=0`・同時1・非active比率0%・warm での
  実測は、下の「測ったこと」に在る（前の担当の測定は、測り方が本 ADR の指定と違っていたため
  使わず、全部測り直した）。

  本 ADR は、①と②に別々の手当てをする:

  - **案A**（本 ADR、非破壊）: ②を部分索引で塞ぐ。
  - **案C**（本 ADR、追加のみ・非破壊）: ①を、呼び出し側が明示的に選んだときだけ止める
    opt-in を足す。

- **北極星の5つの問いに実際に当てた結果**:

  | 問い | 案A | 案C |
  | --- | --- | --- |
  | **1**（毎回渡す量を減らす方向に働くか） | `recall()` のレイテンシを縮める。返り値は1バイトも変わらない。 | `"skip"` を選んだ呼び出しだけレイテンシが劇的に縮む（後述）。既定は変わらない。 |
  | **2**（無効にしても成立するか） | 該当しない——`aggregateScope` の必須経路の実装だけを変える。 | **該当する。** `scopeAggregate` を渡さない呼び出しは今日どおり動く——この opt-in 自体が「無くても Memory Framework として成立する」ことの実例である。 |
  | **3**（選ばれた理由を後から説明できるか） | 同じ結果を返すことを等価性の歯と EXPLAIN で示す——「なぜ速いか」を実装が語れる。 | **これが `"skip"` の代償である**——件数集計を止めると `omitted` の `filtered*` が一切積まれなくなり、「何が落ちたか」を説明できなくなる。`ann_unreached`（ANN が scope の候補を拾いきったか）も判定されなくなる（「決めたこと」7）。`countKind: 'unknown'` がその事実を正直に名乗る（ADR 0008 の系譜）。 |
  | **4**（推論と事実を区別しているか） | 該当しない。 | 該当しない。 |
  | **5**（LLM を呼ばずに済ませられないか） | 元から LLM を呼ばない。索引と `EXPLAIN` で解く。 | 同上。 |

- **決めたこと**:

  ## 案A: `idx_memories_digest_band` 部分索引

  1. **`(tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC) WHERE status IN
     ('active', 'contested')` の部分索引を足す**（`packages/postgres/migrations/0028_digest_band_index.sql`。この PR は当初 `0027` を名乗っていたが、PR #1444 が
     `0027_erase_tenant_fk_indexes.sql` を先に持ったので `0028` に振り直した。`runMigrations` は
     ファイル名の昇順で未適用のものを適用するだけで、番号の連続は要求しない）。
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
     `subjectId` 絞りの呼び出しは、今回の測り直しでは測っていない（下「確かめて
     いないこと」）。

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
  7. **`"skip"` のとき、`ann_unreached` は判定されない（鳴らない）。** その判定は
     `eligible = totalInScope − notIndexed` を母数に `annHits.length < eligible` で
     決まる（`recall-runtime.ts`、ADR 0026/0193）が、`"skip"` では両方が `0` なので
     `eligible` が `0` になり、条件が決して成り立たない。同じ母数を使う
     `explain.stages` の診断キー `annReturnedFewerThanReachable`（ADR 0285/0288）も
     立たない。⟹ **`"skip"` の代償は `filtered*` だけではない——「近似索引が scope の
     候補を拾いきったか」も判定できなくなる。** しかも今は、それを「判定していない」と
     名乗る診断も出さない（`ann_unreached` が無いことは「拾いきった」を意味しない）。
     これは `recall-runtime.ts` の既存のコメント（「段5をスキップする経路が実装されたら、
     この判定はそこでは行えない——根拠が無いため、鳴らさないこと」）の方針どおりの
     挙動だが、本 ADR はこれまでそれを名乗っていなかった。「判定できない」と名乗る
     手当ては本 PR では入れず、ADR 0390（案2の実装）の続きとして別 PR で扱う。

- **測ったこと**:

  ### 器・データ・手順（2026-09-30、このPRの担当が測り直した）

  - **器**: Intel Xeon Platinum 8581C（32 vCPU）・メモリ 251GB（他の作業者と共有の
    Linux 器で、測定中も他のプロセスが動いていた——絶対値は器の負荷で動く）、
    PostgreSQL 17.11（Debian 版、`initdb` で自分専用に立てたインスタンス、
    `shared_buffers=2GB`・`work_mem=4MB`（既定）・ロケール `C.UTF-8`）。
    **接続オプションで `max_parallel_workers_per_gather=0` に固定**（`SHOW` で 0 を
    各点で確かめた）。同時実行数1（1接続）。
  - **データ**: `memories` を全件 `status='active'`（非 active 比率0%）・単一テナント・
    `subject_id` は `floor(power(random(),3) * (行数/100))` の skew・`occurred_at` は NULL・
    `recorded_at` は過去365日の一様乱数。`setseed(0.20260930)`。行数は 100万 と 10万。
  - **問い合わせ**: `PostgresMemoryStore.aggregateScope(ctx, {}, { digestBand: { limit: 50,
    excludeMemoryIds: <8件> } })`（`recall()` が既定で出す形）。案C は同じ呼び出しに
    `scopeAggregate: "skip"` を足したもの。
  - **前と後**: 前 = `origin/main`（案A の前、`15c0c78`）を**別の worktree**
    （`/tmp` 下）に作ってビルドしたもの。後 = このブランチ。**ソースは上書きして
    いない**（2本のビルドを別々の場所に置いた）。
  - **索引の切り替え**: 1つのデータ（行数ごとに1回だけ INSERT）を `agg_<行数>_noidx`
    に作り、main の migration（0001〜0026）だけを適用した。`agg_<行数>_idx` は
    `noidx` を `CREATE DATABASE ... TEMPLATE` で複製し、**このブランチの
    `runMigrations` をそのまま当てて**作った（未適用の `0028_digest_band_index.sql`
    だけが走り、`idx_memories_digest_band` ができる）。⟹ 2つの DB は行も統計
    （`VACUUM ANALYZE` 済み）も同一で、違いは索引1本だけである。前は `noidx`、
    後と skip は `idx` に接続し、**各点の冒頭で `pg_indexes` を見て、索引の有無が
    期待どおりでなければ止まる**。前後の `exact` の返り値（`digests`・
    `digestEligible`・`totalInScope` のハッシュ）が一致することも確かめた。
  - **測り方**: 1点 = 別々の node プロセス（起動 → 1回目を捨てる／記録 → 続けて7回）。
    **12往復**、往復ごとに前・後・skip を1点ずつ、実施順を往復ごとに入れ替えた
    （偶数往復は 前→後→skip、奇数往復は skip→後→前）。p50/p95 は12往復の測定
    84回（7回×12）をまとめた値。**往復ごとの差（後 − 前）は、往復ごとの p50（または
    p95）どうしを引いたもの**で、その12個の中央値と揺れ（四分位範囲 IQR、最小〜最大）を出す。
  - 生の数値・スクリプトは commit していない（測定用の使い捨て）。⚠ 再測定する人は
    上の手順で作り直すこと。

  ### 100万行・warm・並列0・同時1（12往復、各点の測定84回）

  | | p50 | p95 | min〜max |
  | --- | ---: | ---: | ---: |
  | 前（main・索引なし・exact） | 930.4ms | 1030.4ms | 690.1〜1075.8ms |
  | 後（案A・索引あり・exact） | 627.7ms | 714.1ms | 458.1〜796.3ms |
  | 案C（索引あり・`"skip"`） | 1.5ms | 2.0ms | 1.0〜2.6ms |

  | 往復ごとの差 | 中央値 | IQR | 最小〜最大 | 正の往復 |
  | --- | ---: | ---: | ---: | ---: |
  | 後 − 前（p50） | −284.0ms | −308.0〜−250.3ms | −353.3〜−221.8ms | 0/12 |
  | 後 − 前（p95） | −329.4ms | −343.1〜−260.6ms | −408.3〜−211.1ms | 0/12 |
  | skip − 前（p50） | −934.8ms | −959.8〜−830.5ms | −1005.9〜−726.4ms | 0/12 |
  | skip − 後（p50） | −644.6ms | −671.1〜−541.9ms | −681.3〜−504.6ms | 0/12 |

  ⟹ 12往復のすべてで、後は前より小さかった。差の大きさは往復ごとに約220〜350ms と
  揺れる（器が共有で、絶対値は測る時刻の負荷で動く）。
  **「約○%速くなった」とは書かない**——差の中央値と幅がこの測定の結果である。
  差の主因は、下の EXPLAIN が示す `digestBand` 側の `Seq Scan` + top-N `Sort` の消失である。
  `"skip"` は件数集計そのものを発行しないので、差の大半は集計本体の分である
  （後 − skip ≒ 626ms が、索引を足したあとにも残っている集計の費用）。

  ### 10万行・cold と warm-after・並列0・同時1（12往復）

  「cold」は**その点の直前に `pg_ctl restart -m fast`（`shared_buffers` を空にする）
  したあとの、新しい node プロセスの1回目**。「warm-after」は同じプロセスの2〜8回目
  （各点7回、計84回）。

  | | cold p50 | cold p95 | cold min〜max | warm-after p50 | warm-after p95 |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | 前 | 103.3ms | 152.4ms | 91.8〜191.8ms | 73.4ms | 82.0ms |
  | 後 | 72.7ms | 99.7ms | 65.7〜127.2ms | 46.4ms | 55.1ms |
  | 案C（skip） | 6.6ms | 7.3ms | 5.6〜7.8ms | 1.2ms | 1.8ms |

  cold の各値は n=12 で、p95 は粗い（12点のうち上から2番目付近）。

  | 往復ごとの差（後 − 前） | 中央値 | IQR | 最小〜最大 | 正の往復 |
  | --- | ---: | ---: | ---: | ---: |
  | cold（1点どうし） | −31.4ms | −36.0〜−25.1ms | −64.7〜−21.0ms | 0/12 |
  | warm-after（p50） | −27.5ms | −29.6〜−23.1ms | −33.2〜−17.6ms | 0/12 |

  （skip − 前 は cold −96.6ms（IQR −102.3〜−91.9）、warm-after −72.2ms（IQR −73.9〜−70.6）。）

  ⚠ **「cold」の近似の限界**: Postgres の再起動は `shared_buffers` を空にするだけで、
  **OS のページキャッシュは残る**（root ではないので `drop_caches` は使えず、
  測定中は同じ器で他の作業も動いていた）。だからここでの cold は、ディスクから読む
  本物の cold ではなく「Postgres のバッファが空・OS のキャッシュは温かい」状態である。
  ディスク I/O を含む真の cold は測っていない。

  ### #355 を開け直す条件に当てる

  [Issue #355](https://github.com/takecchi/mnemora/issues/355) は**開け直さない**（この
  ADR は #355 の残件のうち、①索引で塞げる分（案A）と、②呼び出し側が選べる止め方
  （案C）だけを入れる）。開け直す条件は「**10万行で 200ms を安定して超えたら**」である。
  今回の10万行の値はこの条件に**当たらない**: 前（main）の最大が cold 191.8ms
  （12点中の1点）、cold の p95 が 152.4ms、warm-after の p95 が 82.0ms で、
  **200ms を超えた点は前でも後でも1つも無かった**。ただし前側の cold の最大は 200ms に
  8ms 手前まで来ており、真の cold（OS キャッシュも空）と、器が遅いときは超えうる
  ——それは今回は測っていない。

  ### 索引の構築時間（参考。1回ずつの測定で、揺れは見ていない）

  このブランチの `runMigrations` で `0028_digest_band_index.sql` だけが走った時間
  （`_mnemora_migrations` への記録を含む）: 100万行で 1212ms（索引 56MB）、
  10万行で 106ms（索引 5.8MB）。この間、`memories` への**書き込みは止まり、読み取りは
  通る**（素の `CREATE INDEX` は `SHARE` ロックを取る——`ACCESS EXCLUSIVE` ではない）。

  ### EXPLAIN（100万行、warm、並列0、`digestBand` の部分だけを取り出した問い合わせ）

  `aggregateScope` の `digestBand` のサブクエリと同じ形の SQL（`tenant_id`・
  `status IN ('active','contested')`・除外 id 1件・`ORDER BY COALESCE(occurred_at,
  recorded_at) DESC, id DESC LIMIT 50`）を手で書き、`EXPLAIN (ANALYZE, BUFFERS)` を
  3回ずつ打った（下は3回目。`aggregateScope` 全体の EXPLAIN ではない）。

  **前（索引なし）**: Execution Time 349.5ms

  ```
  Limit (actual time=349.495..349.505 rows=50 loops=1)
    ->  Sort (Sort Key: COALESCE(occurred_at, recorded_at) DESC, id DESC; top-N heapsort)
          Buffers: shared hit=33340
          ->  Seq Scan on memories (actual time=0.010..237.837 rows=1000000)
  ```

  **後（索引あり）**: Execution Time 0.104ms

  ```
  Limit (actual time=0.024..0.078 rows=50 loops=1)
    ->  Index Scan using idx_memories_digest_band on memories (rows=50)
          Index Cond: (tenant_id = 'bench-tenant')
          Buffers: shared hit=53
  ```

  ⟹ `digestBand` 側は、100万行を舐める `Seq Scan` + top-N `Sort` から、50行だけを
  読む `Index Scan` に変わった（ここは warm のバッファヒットのみの値）。
  **集計本体（`GROUP BY subject_id`、支配項）は案A の対象外**で、`aggregateScope`
  全体の後の p50 627.7ms はほぼそれである（この ADR は本体の内訳の EXPLAIN を
  取り直していない）。

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
     案A のあとの p50 627.7ms のうち、`"skip"`（1.5ms）との差の約626ms が集計に
     掛かったままである——本 ADR が縮めたのは digestBand 側
     （EXPLAIN で 349.5ms→0.104ms）だけであり、`recall()` を条件なしで重くしている
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

  - **300万行規模での案A・案Cの効果は測っていない**（本 ADR の前後測定は
    100万行・10万行に限る）。
  - **並列実行（`max_parallel_workers_per_gather` > 0）を有効にした場合の
    案A・案Cの効果は測っていない**——本 ADR の前後比較は
    `parallel=0` に固定した条件でのみ行った。
  - **同時実行下（複数コネクションが同時に呼ぶ場合）の案A・案Cの効果は
    測っていない**——単発呼び出しの交互実行のみ。
  - **真の cold cache（OS ページキャッシュも空）では測っていない**——
    「Postgres 再起動のみ」という限定的な近似にとどまる（「測ったこと」の限界の注）。
  - **非 active の行（archived/superseded/forgotten）が混ざるデータでは測っていない**
    （全件 active）。部分索引は非 active 行を持たないので索引は小さくなるが、
    前後の差がどう変わるかは見ていない。
  - **索引の構築時間は各規模1回ずつ**で、揺れを見ていない。
  - **測定スクリプトは commit していない**（使い捨て）。「測ったこと」の手順から作り直す。
  - **`subjectId` 絞り・`decayFloorSeqUsesSubjectCounters`・taxonomy
    群カウントを伴う呼び出しの、案A・案C適用後のレイテンシは個別に測って
    いない**——等価性は歯で検査したが、benchmark の対象は基本条件
    （`subjectId` 無し・digestBand あり・`occurredAfter`/`occurredBefore`/
    `validAt` 無し）に限る。
  - **CI が使う `pgvector/pgvector:pg17` と同一環境であることは確認していない**
    （native の PostgreSQL 17.11 + pgvector で測った、ADR 0307 と同じ限定）。
