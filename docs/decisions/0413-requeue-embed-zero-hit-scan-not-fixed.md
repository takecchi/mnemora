# ADR 0413: `requeueEmbedJobs` の「全 status が0件」の走査は、測ったうえで直さない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  `PostgresMemoryStore.requeueEmbedJobs`（`packages/postgres/src/memory-store.ts` の `buildRequeueEmbedTargetSelect`。
  [ADR 0079](./0079-requeue-embed-jobs.md)）の対象選択は、次の形である。

  ```sql
  SELECT id FROM memories
  WHERE tenant_id = $1 AND status IN ('active','contested')
    AND embedding_status = ANY($2::text[])
  ORDER BY updated_at ASC, id ASC LIMIT $3 FOR UPDATE SKIP LOCKED
  ```

  使う索引は migration 0007 の `idx_memories_requeue_embed (tenant_id, updated_at, id) WHERE status IN ('active','contested') AND embedding_status <> 'ready'`
  である。`embedding_status` は索引のキーに入っておらず、**指定した status のどれにも当たる行が無いとき**
  （例: 稀な `failed` を指定して0件）、索引を最後まで読み、`ready` 以外の行を1行ずつ heap から引いて Filter で捨て、
  0行を返す。測定担当が「100万行で 88 ms、行数にほぼ線形」と報告したので、現物で確かめ、直し方の候補を測った。
  **結論は「直さない」である。**

- **決めたこと**:

  1. **クエリも索引も変えない。migration は足さない。**
  2. **`buildRequeueEmbedTargetSelect` の doc に、この挙動と本 ADR への参照を1行足す**（コードは変えない）。
  3. **理由**:
     - **効きが小さい。** `requeueEmbedJobs` の呼び出し元は `Runtime.reembed`（`packages/core/src/runtime.ts`）の1か所だけで、
       `tick()`・`observe()`・`sweepArchive` などの周期処理からは呼ばれない（grep で確認）。
       運用者・アプリが手で行う保守操作（docs の典型は `reembed({ statuses: ["failed"], limit })` → `tick({ kinds: ["embed"] })`）
       の**1回**に、数十 ms かかるだけである。`limit` に既定値は無い（`RequeueEmbedJobsOptions`）。
     - **走査の量は、そのテナントの `ready` 以外の行数に比例する**（総行数ではない）。
       下の表のとおり、`ready` 以外が約4%の100万行で捨てた行は 38,845 行だった。
     - **直すと、恒久的な上乗せが付く。** 案 D は `memories` に索引を1本足す。`reembed` を使わない利用者にも、
       通常の `CREATE INDEX`（`CONCURRENTLY` を付けられない。[migration 0007 の注](../../packages/postgres/migrations/0007_memories_requeue_embed_index.sql)と同じ形）による
       作成中の書き込み停止（全表走査）がかかり、以後の索引の保守も付く。統計が古いと、プランナが新索引＋Sort を選ぶ経路も増える。
       [ADR 0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md) 決定7が purge で「足さない」と決めた前例と同じ形である。

- **検討した代替案**（実測は下の「測ったこと」）:

  1. **案 A0: 先に既存の索引で存在確認をし、0件なら本 SELECT を打たない。** 採らなかった。
     0007 に `embedding_status` がキーとして無く Index Only Scan にならないので、存在確認自体が本 SELECT と同じ走査になる。
  2. **案 A1: 存在確認のために小索引 `(tenant_id, embedding_status) WHERE … AND embedding_status <> 'ready'` を足す。**
     採らなかった。存在確認は速くなるが、往復が1回増え、索引も足す。同じ索引だけで案 D が成り立つ。
  3. **案 B1: `embedding_status` ごとの部分索引3本を足す（0007 は残す）。** 採らなかった。
     単一 status は速くなるが、`= ANY('{a,b}')` は単一 status の部分索引の述語を含意しないので、
     複数 status では 0007 に戻り、**「全部空」の複数 status（例 `failed`,`skipped`）は遅いまま**。索引が3本増える。
  4. **案 B2: 0007 を落として部分索引3本だけにする。** 不可。複数 status が Seq Scan＋Sort になる（100万行で 270〜420 ms）。
  5. **案 B3: 部分3本＋クエリを status ごとの UNION ALL（Merge Append）に書き換える。** 採らなかった。
     全ケースで速いが、`FOR UPDATE SKIP LOCKED` を UNION に付けられず、ロックを外側の別段に移すと
     SKIP LOCKED と LIMIT の意味が変わる。設計のやり直しになる。
  6. **案 C: 0007 のキーを `(tenant_id, embedding_status, updated_at, id)` に替える。** 採らなかった（不可）。
     単一 status でも `= ANY('{pending}')` が ScalarArrayOp のままで並び順を供給せず、Sort が挟まり、
     多数ヒットの status が 37〜85 ms に劣化した。0007 が「`embedding_status` をキーに入れない」と書いている理由（ADR 0032）を追認する結果である。
  7. **案 D: 0007 を残し、小索引 `(tenant_id, embedding_status) WHERE status IN ('active','contested') AND embedding_status <> 'ready'` を1本足す。クエリは変えない。**
     **技術的には最良**（測った全ケースで 0.5 ms 未満）。**今は採らない**——決定3の理由。「これが覆るとしたら」で第一候補にする。

- **引き受けた負債**:

  - **`ready` 以外の行が多いテナントで、稀な status を指定した `reembed` は、100万行で温 約30 ms／冷 約80〜95 ms、
    300万行で温 約100 ms／冷 約250 ms かかる。** 結果は正しく、遅いだけ。
  - **`reembed` を周期的に、あるいは「空振り確認」の形で叩く利用者が出ると、この費用が毎回かかる。**
    repo 内にそういう呼び出し元は無い（決定3）が、`Runtime.reembed` は公開の口であり、外の利用者の使い方は見えない。
  - この判断は分布（`ready` 約96%、`pending` 約4%、`failed`・`skipped` は0件）で測ったものである。

- **これが覆るとしたら**:

  - **`reembed` を周期的・空振り確認的に叩く呼び出し元が repo に生まれたとき**（例: `tick` の一部として自動で積み直す）。
  - **`ready` 以外の行が大きく溜まる運用が実測されたとき**（走査の量はその行数に比例する）。
  - そのときの**第一候補は案 D**（0007 を残し、小索引を1本足し、クエリは変えない）。**migration 番号は 0033 を使う想定**である
    （この ADR の時点で 0031 まで当たっている。0032 は、他の変更が取りうるので空けておく）。**今回は migration を足していない。**
    足すときは、稀な status（0件）の EXPLAIN の歯（`memories-requeue-embed-index.test.ts` の隣）と、
    本 ADR の数字の取り直しを同じ PR に含めること。

## 測ったこと

【実測】2026-09-30、自前の Postgres 17（pgvector 入り、ポート 55731、`initdb` で立てた使い捨て DB。`fsync=off`、`shared_buffers=4GB`）。
migration は repo の `migrate` で 0031 まで当てた。**実験のため、`memories` の 0007 以外の索引（主キー以外）は落とし**、
データ投入後に必要な索引だけ作り直した。heap は実サイズ（`content` 約250バイト。100万行で 460 MB）。
分布は `ready` 約95.9%、`pending` 約4.1%（`superseded` 混じり。`active`・`contested` の `pending` は100万行のテナントで 38,845 行）、
`failed`・`skipped` は0件。`updated_at` は投入順に単調増加、`pending` は物理的に散らした。
テナント: `small`=10万、`big`=100万、`huge`=300万、`mt0`〜`mt8`=各10万（物理的に interleave して投入）。表全体は約500万行。
`PREPARE` ＋ `plan_cache_mode=force_custom_plan` で、`BEGIN; EXPLAIN (ANALYZE, BUFFERS) EXECUTE …; ROLLBACK;`。`LIMIT 100`、`FOR UPDATE SKIP LOCKED` 付き。
**時間は「1回目（冷）／3回目（温）」の ms。器の負荷でばらつく。この数字は「直さない」判断の根拠であって、性能保証ではない。**

### 現状（0007 のみ）

| ケース | 冷／温 | プラン要点 |
| --- | --- | --- |
| big（100万）`{failed}`（0件） | 76〜95／25〜29 ms | 0007 を Index Scan。Filter で 38,845 行捨てた。Buffers hit=28,779 read=236。Sort なし |
| big `{pending}` | 0.44／0.12 | 同じ索引。100行で早期打ち切り。Buffers 278 |
| big `{failed,pending}` | 0.43／0.12 | 同上 |
| big `{pending,failed,skipped}` | 0.38／0.09 | 同上 |
| big `{failed,skipped}`（両方0件） | 75／32 | `{failed}` と同じ。Buffers 29,015 |

**遅いのは「指定した status のどれにも当たる行が無い」ときだけ。** 多数ヒットする status が1つでも混じれば早期打ち切りが効く。

### 行数を変えたときの伸び（現状の `{failed}`、0件）

| テナント（行数） | 捨てた行数 | 冷／温 |
| --- | --- | --- |
| small（10万） | 3,791 | 8.0／2.7 ms |
| mt3（10万、interleave） | 3,920 | 21／4.3 ms |
| big（100万） | 38,845 | 95／29 ms |
| huge（300万） | 約11.6万 | 251／96 ms |

ほぼ線形。冷は温の約3倍。interleave すると heap が散る分だけ少し重い。

### 案 A0・A1（存在確認）

| 案 | ケース | 冷／温 |
| --- | --- | --- |
| A0（0007 のみ） | `{failed}`（0件） | 71／28 ms（本 SELECT と同じ Index Scan、38,845 行捨てる） |
| A0 | `{failed,skipped}`（0件） | 83／33 ms |
| A1（小索引を足す） | `{failed}`（0件） | 0.09／0.011 ms（Index Only Scan、Heap Fetches 0、Buffers 2） |
| A1 | `{pending}`（ヒットあり） | 0.08／0.006 ms |
| A1 | `{failed,skipped}`（0件） | 0.11／0.010 ms |

小索引の大きさは、100万行で 288 kB。

### 案 B1・B2（部分索引3本）

| 案 | ケース | 冷／温 | プラン |
| --- | --- | --- | --- |
| B1（0007 を残す） | `{failed}` | 0.034／0.010 ms | `idx_mrq_failed`。Buffers 2 |
| B1 | `{pending}` | 0.44／0.12 | `idx_mrq_pending` |
| B1 | `{failed,pending}` | 0.49／0.11 | 0007（部分索引は使えない） |
| B1 | `{pending,failed,skipped}` | 0.51／0.10 | 0007 |
| B1 | `{failed,skipped}` | 75／31 | 0007。**改善なし**。300万行でも 0007 を使い 約100 ms（再測定） |
| B2（0007 を落とす） | `{failed}` | 0.04／0.01 | `idx_mrq_failed` |
| B2 | `{pending}` | 0.6／0.13 | `idx_mrq_pending` |
| B2 | `{failed,pending}` | 360／273 | Seq Scan＋Sort、58,830 buffers |
| B2 | `{pending,failed,skipped}` | 420／370 | Seq Scan＋Sort |
| B2 | `{failed,skipped}` | 330／290 | Seq Scan＋Sort |

B1 で Sort が挟まって早期打ち切りが崩れる場面は無かった（複数 status は 0007 が並びを供給する）。

### 案 B3（UNION ALL に書き換え、部分3本のみ）

各枝に `ORDER BY updated_at,id LIMIT 100`、外側でも `ORDER BY … LIMIT 100`。Merge Append になり Sort なし、早期打ち切りも効いた。
big で 0.16〜0.32 ms、huge でも約 0.2 ms。**`FOR UPDATE SKIP LOCKED` を含めた形は測っていない**（付けられない、決定の代替案5）。

### 案 C（キーを `(tenant_id, embedding_status, updated_at, id)` に替える）

| ケース（big） | 冷／温 |
| --- | --- |
| `{failed}` | 0.09／0.008 ms |
| `{pending}` | 82／37 ms（Index Scan で 38,845 行を読み Sort） |
| `{failed,pending}` | 85／38 |
| `{pending,failed,skipped}` | 93／38 |
| `{failed,skipped}` | 0.15／0.02 |

### 案 D（0007 ＋ 小索引1本、クエリ変更なし）

| テナント | `{failed}` | `{pending}` | `{failed,pending}` | `{pending,failed,skipped}` | `{failed,skipped}` |
| --- | --- | --- | --- | --- | --- |
| big（100万） | 0.078／0.012 | 0.97／0.14 | 0.62／0.17 | 0.50／0.13 | 0.125／0.016 |
| huge（300万） | 0.116／0.021 | 0.73／0.13 | 0.58／0.11 | 0.81／0.15 | 0.14／0.027 |

（単位 ms、冷／温。）稀な status は小索引＋Sort（マッチ行が少ないので安価）、多数ヒットの status は 0007 で早期打ち切り、とプランナが自動で使い分けた。
**統計が古いとき**（`ANALYZE` 前に `failed` を3万行にした）は、小索引＋Sort を選び続けて 13〜18 ms。上限はマッチ行数の Sort で、現状の 25〜96 ms より悪くならない。`ANALYZE` 後は 0007 に戻り 0.25 ms。

### 書き込み側の上乗せ

`setEmbeddingStatus`（`memory-store.ts`）も `requeueEmbedJobs` の UPDATE も、`embedding_status` と `updated_at = now()` を同時に書く。
`updated_at` は 0007 のキー、`embedding_status` は 0007 の述語列なので、**0007 がある時点で、この更新はすでに HOT にならない**
（実験表で、0007 を付けると HOT 更新は 0 件／330,000 更新。主キーのみでは 1 件）。**索引を足しても HOT の損失は増えない。増えるのは索引エントリの保守だけ。**
定常状態（新規 Memory が `pending` で入り、すぐ `ready` になる）では、`ready` の新タプルは部分索引の述語を満たさないので、
INSERT 時に「`pending` 側の索引エントリ」が1つ増えるだけである。

実験表（主キー＋候補の索引だけ。実表は17本前後の索引を持つので、相対的な影響はもっと小さいはず）で、30万行 INSERT（`pending`）→ 全件 `ready` へ UPDATE → 3万行を `pending` へ戻す、を1回ずつ測った（ms）:

| 構成 | INSERT | UPDATE→ready | UPDATE→pending | 索引合計 |
| --- | --- | --- | --- | --- |
| 主キーのみ | 2056 | 2277 | 398 | 18 MB |
| ＋0007 | 2190 | 2354 | 528 | 34 MB |
| ＋0007＋部分3本 | 2334 | 2203 | 473 | 51 MB |
| ＋0007＋小索引 | 2332 | 2164 | 437 | 36 MB |

差は1回ずつの測りのばらつきの範囲内で、有意な悪化は見えなかった。**「書き込みが重くなる」のではなく、「作成時の書き込み停止と、恒久的な保守が付く」ことを、直さない理由にしている。**

## 確かめていないこと

- **`ready` 以外が多数を占める分布**（`failed`・`skipped` が多い、`pending` が半分以上）。測ったのは `ready` 約96%・`pending` 約4% だけ。
- **実表の17本前後の索引を全部載せた状態での書き込み比較**（実験表は 0007 と候補の索引だけ）。
- **`node-postgres` を通した実測**（custom plan の再現は `PREPARE` ＋ `force_custom_plan` で代用した）。
- **300万行を超える規模、並行書き込み下の測定。**
- **`FOR UPDATE SKIP LOCKED` を含めた案 B3 の形**（付けられないため）。
- 上の数字は自前の1台の器での1〜3回ずつの測りであり、再現性の幅は見ていない。絶対値は目安である。
  推測を事実の顔で書かない。これは北極星の問い3（説明できるか）の、文書への適用である。

## 追記（2026-10-06）: 決定3の「ADR 0404 決定7と同じ形」は、同じ日に前例が逆になっていた

クローン（miku）の判断で残す訂正。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734) の #1500 のコメント（確かめ直しの記録）。**本文は書き換えていない。**

- **何がずれたか**: 決定3の理由（③）は、直すと恒久的な上乗せが付くことを「[ADR 0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md) 決定7が purge で『足さない』と決めた前例と同じ形」と書いた。**その前例は、この ADR と同じ日（2026-09-30）に [ADR 0412](./0412-purge-target-select-indexes.md) が改めた。** 0412 は「100万行で `purgeExpiredRecalls` が 409 ms かかり、0404 の『これが覆るとしたら』の最後の項目が起きた」として、`recalls`・`outbox` に索引を足した（migration `0032_purge_indexes.sql`）。今この理由を読むと、前例の向きが逆になっている。
- **この ADR の決定は変わらない。** 「直さない」・覆る条件・第一候補（案 D）は、後の ADR に撤回も変更もされていない。決定3のほかの理由（効きが小さい・呼び出し元が手動の1か所・走査量は `ready` 以外の行数に比例する）は、前例の逆転に影響されない。③は「前例と同じ形」という支えを失っただけで、「恒久的な上乗せが付く」こと自体は残る。
- **線の引き方が揃っていない（判断の食い違いであって、記述の誤りではない）**: 0412 は「100万行で 409 ms は許容外」として索引を足した。この ADR は「100万行で温 約30 ms（300万行で温 約100 ms／冷 約250 ms）は許容」として足さなかった。0412 の対象は purge（保守ジョブ）、こちらは `reembed`（手動の口）で、呼ぶ頻度と呼び出し元が違うので、線が違ってよい理由は立つ。ただし、2つの ADR は同じ日に書かれ、許容の線を共通の物差しで引いていない。**線を揃えるかは、この追記では決めていない。** 揃えるなら、「覆るとしたら」の条件（周期的な呼び出し元・`ready` 以外の蓄積の実測）を満たしたときに、案 D を採る判断と一緒に行うのが自然である。
- **確かめたこと【現物】**: 0412 の本文の 409 ms の記述と、0404 の末尾の追記。この ADR の数字（温 約30 ms など）は、自前の器での再現はしていない（`shared_buffers` の条件が違い、時間は比べられなかった。プランの形と捨てる行数だけが一致した）。
- **参考**: 「この ADR の時点で 0031 まで当たっている」は当時の記録として正しい（今は 0032 まで。0033 は空いている）。
