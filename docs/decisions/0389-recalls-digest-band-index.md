# ADR 0389: `recalls.index_band` の目次帯に式の GIN 索引を足す——`purgeMemory` が `recalls` を全部読まないようにする

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0375](./0375-purge-scope-widened.md) 決定3は、`purgeMemory` が同じテナントの
  `recalls.index_band` の目次帯（`digestBand`）から、purge した `memoryId` のエントリを
  探してトゥームストーンへ書き換えると決めた。決定6は、その `UPDATE` が
  `idx_recalls_by_subject (tenant_id, subject_id, created_at)` でテナントへ絞ったあと、
  `index_band` の中身を行ごとに調べるためテナントの `recalls` を全部読むことを実測し
  （10万行・対象1%で中央値約285ms）、**索引を足す最適化は範囲外**とした。
  「引き受けた負債」1 がそれを負債として残し、「これが覆るとしたら」の4番目が
  「purge がテナント単位の一括操作として高頻度に呼ばれるようになったら見直す」と書いた。

  [ADR 0383](./0383-erase-tenant.md)（[PR #1444](https://github.com/takecchi/mnemora/pull/1444)）が
  テナント単位の消去を `eraseTenant` として新設したので、purge を大量に呼ぶ運用の
  典型的な入口は、`eraseTenant` に置き換わる形で減った。それでも `purge()` を1件ずつ
  呼ぶ運用（法的な要求への個別の応答）は残り、`recalls` が育つほど1回あたりの費用は
  線形に増える。負債1を解消する（採る案——式の GIN 索引——は、この作業を依頼した
  側が決めて指示した）。

- **決めたこと**:

  1. **`migrations/0030_recalls_digest_band_index.sql` で、式の GIN 索引を足す。**

     ```sql
     CREATE INDEX idx_recalls_digest_band
       ON recalls USING gin ((index_band->'digestBand') jsonb_path_ops);
     ```

     `purgeMemory` の `WHERE` 句の `index_band->'digestBand' @> jsonb_build_array(...)` は、
     索引の式と一致しているので**クエリ側は1文字も変えていない**（EXPLAIN で確認した。
     下の「実測」）。結果も変わらない。

  2. **`jsonb_path_ops` を選ぶ。** 使うのは `@>` だけで、`?` は索引を使わない
     （`index_band ? 'digestBand'` は絞られた行への Filter として残る。`@>` が真なら
     `digestBand` は必ず在るので結果は同じ）。`jsonb_path_ops` は `@>` 専用で、既定の
     `jsonb_ops` より小さく書き込みも軽い。

  3. **部分索引にしない・`CONCURRENTLY` を付けない。** 部分索引にする条件
     （`digestBand` を持たない行が多数派になる見込み）が無い。`CONCURRENTLY` は
     `migrate.ts` が各 migration を1トランザクションで包むため使えない
     （0002/0003/0004/0007/0010/0027 と同じ前例）。⟹ 作るあいだ `recalls` への書き込みが
     止まる。

  4. **歯**: `packages/postgres/src/__tests__/recalls-digest-band-index.postgres.test.ts`。
     (a) `purgeMemory` の `UPDATE` と同じ述語の `EXPLAIN` が `idx_recalls_digest_band` を
     使う、(b) 実際に `purgeMemory` を呼ぶと索引の `idx_scan` が増え、対象エントリだけが
     伏せられる。どちらも専用の接続で `enable_seqscan = off` にして planner の見積もりの
     揺れを避ける（索引が無ければ `idx_recalls_by_subject` へ倒れるだけなので、歯は
     噛む）。既定の planner 設定で選ばれることは下の実測が示す。

- **検討した代替案**:

  1. **`index_band` 全体に GIN 索引（`jsonb_path_ops`）を張る。** ⛔ 採らなかった——
     `digestBandCoverage` など、purge が探さない部分まで索引に入り、`createRecall` の
     書き込みが重くなる。式索引で `digestBand` だけを索引に入れる。
  2. **`(tenant_id, ...)` を先頭にした複合 GIN（`btree_gin`）。** ⛔ 採らなかった——
     `memoryId` は一意な UUID で、`@>` 単独でも十分に絞れる（対象は全体の1%）。
     `tenant_id` の絞り込みは、ヒープを引いたあとの Filter で足りる。複合にすると
     索引が大きくなる割に得るものが無い。`tenant_id` の条件は他テナントの行を
     変えないための境界であり、索引で絞るためではない。
  3. **`CREATE INDEX CONCURRENTLY` を migration の外で別途行う。** ⛔ 採らなかった——
     利用者の手作業が増え、migration の一覧が実際のスキーマと食い違う経路になる。
     0027 までの前例に合わせる。
  4. **`recalls` を別の形（正規化した `recall_digest_entries` 表など）にする。**
     ⛔ 採らなかった——スキーマ変更の範囲が大きく、この PR の範囲を超える。

- **引き受けた負債**:

  1. **`createRecall` の INSERT が、GIN の維持の分だけ重くなる**（下の実測: 5,000行の
     単発 INSERT で中央値 +9%）。recall は purge より頻度が高いので、この上乗せは
     全 recall に乗る。GIN の `fastupdate`（保留リスト）に頼っており、保留リストの
     フラッシュが重なった INSERT では裾が伸びうる（下の表の最大値は中央値の約1.14倍。
     ただし索引なしの側の最大値も約1.48倍で、この測定の揺れの範囲を出ていない）。
  2. **索引を作るあいだ `recalls` への書き込みが止まる**（`CONCURRENTLY` を使わない）。
     10万行で約5秒。行数に比例する。
  3. **索引のサイズ**が `recalls` に乗る（10万行で約34MB）。
  4. **`recalls` の保持方針が未決のまま**（ADR 0290）。`recalls` が無限に育つ運用では
     索引も育つ。索引で `purgeMemory` の費用は行数の一次関数ではなく対象行の数に
     比例するようになったが、書き込み側・容量側は行数に比例し続ける。

- **オーナーの判断（2026-09-30）**: recall の記録の INSERT が約+9%（1行あたり約5µs）遅くなるのは、recall 1回の費用から見れば小さく、purge が 393→75ms になる代わりとして、オーナーが受け入れた。

- **これが覆るとしたら**:

  - `createRecall` の書き込み費用が問題になったとき（recall の頻度が非常に高い運用）
    ⟹ GIN の `fastupdate`・`gin_pending_list_limit` の調整、または `digestBand` を
    別表へ切り出す（代替案4）を検討する。今回は調整していない。
  - `recalls` が100万行を大きく超えるとき ⟹ 索引の作成時間（書き込み停止）が受け入れ
    られなくなる。`CONCURRENTLY` を使える migration の作法（別経路）が要る。
  - purge が `recalls` の保持方針（ADR 0290）で行ごと消える運用になったとき ⟹ この
    索引を持つ理由自体が薄れる。

- **実測**【2026-09-30、PostgreSQL 17 + pgvector、`initdb` で立てた自分専用のインスタンス、
  単一接続・他の負荷なし。使い捨てスクリプトで、commit していない】:

  ADR 0375 決定6 と同じ手順: テナント `benchtenant` に `recalls` を10万行 INSERT。各行の
  `index_band.digestBand` は5エントリ（1エントリは UUID と日本語の要約。ADR 0375 の
  ときより短い）。うち1%（1,000行）が対象の `memoryId` を1エントリとして持つ。

  ⚠ **ADR 0375 決定6 の数字（中央値285ms・約180MB）とは、そのまま比べないこと。**
  行の中身・機械が違う（今回の索引なしの中央値は約394ms）。本 ADR は同じ機械・同じ
  データで、索引の有無だけを変えて測った。

  **1. `purgeMemory` の `UPDATE`（`recalls` の書き換え）**——7回、`BEGIN; UPDATE ...; ROLLBACK;`
  で `psql \timing`（対象行の書き換えは毎回ロールバックするので、繰り返しても同じ状態）:

  | | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 中央値 |
  |---|---|---|---|---|---|---|---|---|
  | 索引なし(ms) | 449.8 | 393.6 | 515.7 | 363.9 | 369.3 | 414.0 | 357.2 | **393.6** |
  | 索引あり(ms) | 91.9 | 73.9 | 66.7 | 67.6 | 82.9 | 103.0 | 74.9 | **74.9** |

  中央値で約5.3倍速い。残りの約75msは、対象1,000行の書き換え自体の費用（索引が
  絞るのはスキャンの費用で、書き換えの費用は変わらない）。

  **`EXPLAIN (ANALYZE, BUFFERS)`（既定の planner 設定、`enable_seqscan` は触っていない）**:

  - 索引なし: `Seq Scan on recalls`、`Rows Removed by Filter: 99000`、Execution Time 348.6ms。
  - 索引あり: `Bitmap Heap Scan on recalls`（`Recheck Cond: (index_band -> 'digestBand') @> ...`）
    ←`Bitmap Index Scan on idx_recalls_digest_band`、`Heap Blocks: exact=999`、
    Execution Time 88.7ms。クエリ側の式を変えずに索引が選ばれた。

  **2. `createRecall` 相当の INSERT の費用**——`recalls` に10万行ある状態で、5エントリの
  `index_band` を持つ行を1行ずつ 5,000 回 INSERT する（`DO` ブロックのループ、
  `BEGIN; ...; ROLLBACK;`）時間。各回の前に `VACUUM recalls` と `CHECKPOINT`。7回:

  | | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 中央値 |
  |---|---|---|---|---|---|---|---|---|
  | 索引なし(ms/5,000行) | 248 | 261 | 402 | 235 | 272 | 307 | 278 | **272**（54.4µs/行） |
  | 索引あり(ms/5,000行) | 259 | 279 | 265 | 285 | 296 | 335 | 337 | **296**（59.2µs/行） |

  中央値で **+24ms/5,000行（約+9%、1行あたり約+5µs）**。

  ⚠ **この INSERT の測定は、最初の試行では乱れた**（索引あり: 265, 461, 708, 456, 269,
  302, 995ms）——直前のロールバックで溜まった dead tuple と GIN の保留リストのフラッシュ、
  チェックポイントが重なったためと考えている（確かめていない）。上の表は、各回の前に
  `VACUUM`・`CHECKPOINT` を入れて測り直した数字である。**本番の recall の書き込みは
  単発のトランザクションであり、この測定（1トランザクションに 5,000 行）とは形が違う**
  ——「GIN の保留リストのフラッシュがいつ誰の INSERT に乗るか」は測っていない。

  **3. 索引の作成とサイズ**: `CREATE INDEX`（10万行）5.0秒、索引のサイズ 34MB。

- **確かめたこと（赤の証拠）**:

  `origin/main`（`1becd89`）から切った使い捨て worktree
  （`/tmp/mgr-ee161643-red`、migration 0030 が無い）に、`recalls-digest-band-index.postgres.test.ts`
  だけを `cp` して走らせると、2件とも赤くなる。(a) は `Bitmap Index Scan on idx_recalls_by_subject`
  へ倒れ `idx_recalls_digest_band` を含まない、(b) は `idx_recalls_digest_band` が無い。
  枝（0030 あり）では2件とも緑。コマンドと結果は PR 本文にある。

- **確かめていないこと**:

  - `recalls` が10万行を大きく超える規模（100万行以上）での作成時間・費用。
  - 実際の `createRecall`（アプリケーション経由の単発 INSERT・並行書き込み）への上乗せ。
    上の INSERT の測定は SQL の直接実行である。
  - 対象が1%より多い・少ない場合の費用（対象が多いと、planner が Seq Scan を選ぶことがある）。
  - `gin_pending_list_limit`・`fastupdate` を変えたときの書き込みの裾。
  - ADR 0375 追記（`FOR UPDATE` との相互作用）が測った purge の待ち時間への効果
    （`UPDATE recalls` が短くなれば待ちも短くなるはずだが、測っていない）。

## 追記（2026-09-30）: 既定の `DEFAULT_DIGEST_BAND_LIMIT`（50件）では、`CREATE INDEX` は約25秒・約381MB になる

⛔ 上の本文・実測の数字は書き換えていない。決定3（`CONCURRENTLY` を付けない。[Issue #760](https://github.com/takecchi/mnemora/issues/760) の決定）も変えていない。

**何が食い違っていたか。**上の実測は「10万行・1行あたり目次帯5エントリ」で `CREATE INDEX` 5.0秒・索引34MB だった。しかし `recall()` の既定の目次帯は `DEFAULT_DIGEST_BAND_LIMIT = 50`（`packages/core/src/recall.ts`）で、**実運用の `recalls` の `digestBand` は最大50エントリ**になる。5エントリで測った「10万行で約5秒」を既定の利用者の見積もりに使うと、桁が違う。

**測り直した結果**（別の担当の実測と、この PR の実測。2つは一致した）:

- **別の担当の実測**: 10万行・50エントリで約24秒・約381MB。**この PR ではその測り方は見ていない**（数字だけを受け取った）。
- **この PR の実測（2026-09-30）**【自分専用の PostgreSQL 17 + pgvector（`initdb` の手順、`maintenance_work_mem` 64MB・`shared_buffers` 128MB の既定のまま）、単一接続・他の負荷なし。使い捨ての SQL で、commit していない】: `migrate` で全 migration を適用した DB から `idx_recalls_digest_band` を落とし、`recalls` にテナント `benchtenant` の10万行を INSERT した（各行の `index_band.digestBand` は50エントリ。1エントリは UUID（`gen_random_uuid()`）と約30文字の日本語の要約。`query`/`usage`/`returned_memories` は最小の JSON）。表は278MB。そこで上の migration と同じ `CREATE INDEX idx_recalls_digest_band ON recalls USING gin ((index_band->'digestBand') jsonb_path_ops)` を `psql \timing` で測った。**25.9秒（1回目）・24.4秒（2回目）、索引のサイズ 381MB（399,925,248バイト）。**別の担当の約24秒・約381MB と一致した。

**引き受けた負債2・3の読み替え。**「索引を作るあいだ `recalls` への書き込みが止まる（10万行で約5秒）」は、**既定の目次帯の件数では10万行で約25秒**であり、索引は34MBではなく約381MB（`recalls` 本体の約278MB を超える）になる。**行数に比例する**点は変わらない——100万行なら桁が1つ上がると見込まれるが、**100万行は測っていない**（上の「確かめていないこと」と同じ）。**適用は書き込みの少ない時間帯に当てること**（`docs/migration-v1.md` の `0030` の段落にも同じことを書いた）。

**確かめていないこと（この追記）**: 5エントリでの5秒の再現（この PR は50エントリだけを測った）。`purgeMemory` の `UPDATE` の高速化（決定の動機）と、`createRecall` の `INSERT` への上乗せを、50エントリで測り直すこと——**上の本文の「約5.3倍速い」「約+9%」は5エントリの値であり、50エントリでは変わりうる**（`digestBand` が大きいほど、索引のキーも増えるので、INSERT への上乗せは増えると考えられるが、測っていない）。10万行を超える規模。
