# ADR 0412: `purgeExpiredRecalls` と `purgeCompletedJobs` の対象選択に索引を足す（ADR 0404 決定7を改める）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  [ADR 0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md) 決定7は、purge の2つの口の対象選択に
  索引（migration）を**足さない**と決め、「これが覆るとしたら」に「実運用の行数で purge の1回が遅すぎると
  分かったとき。索引 migration を足す」と書いた。その判断は 40万〜60万行の測定に立っていた
  （1テナント60万行・`limit 1000` で1回が約 0.1 秒）。

  前任の担当が main `e9e7520` で **100万行**を測り直した（本 ADR の担い手はこの数字を再現していない。引用である）:

  | 口（`limit 100`） | p50 | 備考 |
  | --- | --- | --- |
  | `purgeExpiredRecalls` | 409 ms | 行数に比例。`WHERE tenant_id=… AND created_at<… ORDER BY created_at,id LIMIT n+1 FOR UPDATE` が `recalls` の Seq Scan + Sort |
  | `purgeCompletedJobs` | 312 ms | 対象が 0 件でも 153 ms。`outbox` の索引はどれも `completed_at IS NULL` の部分索引で、この問い合わせに使えない |

  同じ前任の測りで、`recalls (tenant_id, created_at, id)` を足すと約 2 ms、
  `outbox (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL` を足すと約 0.4 ms だった。
  0404 の「保守ジョブの許容内」は、行数が 1 桁増えると成り立たない。**これは 0404 の「これが覆るとしたら」の
  最後の項目が起きた、ということである。**

  `e9e7520` から本 ADR の時点の main（`cf8fa0d`）までに、purge の SQL
  （`buildPurgeExpiredRecallsTargetSelect` と `purgeCompletedJobs` の2つの SELECT）は変わっていない
  （`git diff e9e7520 origin/main -- packages/postgres/src/outbox-store.ts` は空。`memory-store.ts` の差分に
  purge の SQL の変更は無い）。前任の数字はいまの SQL に当てはまる。

- **決めたこと**:

  1. **migration `0032_purge_indexes.sql` で索引を2本足す。**
     - `idx_recalls_by_created ON recalls (tenant_id, created_at, id)`（部分索引ではない）
     - `idx_outbox_completed ON outbox (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL`

     形は 0027・0029 に合わせる（先頭のコメントで目的・列・述語を説明し、トランザクション内の素の
     `CREATE INDEX`）。**`CONCURRENTLY` の経路は作らない**（Issue #760 の決定）。
     SQL・返り値・公開 API は変えない。
  2. **`purgeCompletedJobs` の対象 SELECT を export した builder
     `buildPurgeCompletedJobsTargetSelect(ctx, opts, lock)` に切り出す。** `purgeExpiredRecalls` の
     `buildPurgeExpiredRecallsTargetSelect` と同じ形で、歯が本体の打つ SQL をそのまま `EXPLAIN` できる。
     dry-run の SELECT は `id` も返すようになる（従来は `completed_at` だけ）。行数・並び・述語は同じ。
  3. **歯**（ADR 0404 の向きを逆にした）:
     - `recalls-purge-index.test.ts`: 従来は「Sort が入る」を縛っていた。索引がある世界で Index Scan
       （削除しない SELECT は Index Only Scan もありうる）になり、`Sort` も `Seq Scan` も無いことを縛る。
       陽性対照は、索引を落とすと `Sort` が挟まること。
     - `outbox-purge-index.test.ts`（新設）: 同じ形に加え、対象 0 件で `EXPLAIN (ANALYZE, BUFFERS)` の
       読んだバッファが表のページ数の 2% 未満であること、索引を落とすと表の 90% 超を読むこと。

- **書き込み側の上乗せを受け入れる理由**（0404 決定7・「測ったこと」の判断 (a) への答え）:

  0404 は、索引を足すと全 recall の INSERT と全 outbox の `complete` に、purge を呼ばない利用者も含めて
  恒久的な上乗せが乗るので足さない、と判断した。**その上乗せは今も在る。受け入れる。**

  - **上乗せは1回あたりマイクロ秒である。** 下の10万行の測りで、recall の INSERT は 1 回あたり
    約 2.7 µs、`complete` の UPDATE は約 4 µs 増える（20,000 回の合計で +20〜45%）。
    絶対値は小さい。ただし **recall 全体の中でどれだけの割合かは測っていない**。
  - **`complete` の UPDATE は `completed_at`（索引列）を書くので HOT 更新にならない。**
    0404 が挙げた上乗せと同じ機構である。`idx_outbox_completed` は完了した行だけを索引に入れる
    部分索引なので、未処理の行（`INSERT` や `claimBatch` の UPDATE）には乗らない。
  - **一方、索引が無い側の費用は行数に比例して増え続ける。** purge は定期ジョブとして繰り返し呼ぶ口で、
    対象が 0 件でも表を全部読む（100万行で outbox 153 ms）。書き込みの上乗せは1回ごとに一定、
    索引が無い側の費用は表の大きさに比例する。0404 の「行数は purge を呼ぶほど減るので、走査の費用は
    自己限定的」は、purge を**呼ぶ**利用者にしか当てはまらず、呼ぶ利用者ほど毎回その走査を払う。
  - **`recalls` の索引は ADR 0389 の `idx_recalls_digest_band` に続く3本目になる**
    （`idx_recalls_by_subject`・`idx_recalls_digest_band`・本 ADR の `idx_recalls_by_created`）。
    3本目の上乗せは上で測った。4本目以降は、この ADR を根拠にしないこと。

- **索引作成中は `ShareLock` で書き込みが止まる**:

  通常の `CREATE INDEX` は、作る間 `recalls` と `outbox` への INSERT/UPDATE/DELETE を止める（読み取りは通る）。
  migration は1トランザクションで包まれ、`CONCURRENTLY` はその中で実行できない。手で流せる経路も作らない
  （Issue #760）。**止まる時間は表の行数で決まる。** 10万行（同一 DB に `recalls` 12万行・`outbox` 12万行）で、
  2本を作り直したとき、それぞれ 88〜97 ms（手元の1回ずつ。下の「索引の作成」）。

