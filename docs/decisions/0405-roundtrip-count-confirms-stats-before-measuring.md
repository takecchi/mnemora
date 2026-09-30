# ADR 0405: `recall-roundtrip-count` は、往復を数える前に `StatsPresenceGate` を確認済みにする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

- **文脈**:

  `packages/postgres/src/__tests__/recall-roundtrip-count.postgres.test.ts` の歯2
  （limit=5/20/50 で `recall()` の往復数が等しい）が、PR #1472（`isolate: false`、
  ADR 0397。#1472 と一緒に入るので、本 ADR の時点では main に無い）の CI で1回だけ赤になった
  （run 36664582749、`expected 14 to be 15`）。

  `StatsPresenceGate`（`vector-store.ts`、[ADR 0374](./0374-search-stats-presence-instance-cache.md)）は、
  `memories` と埋め込み表の**両方**が `reltuples >= 0` と確かめられるまで、`search()` のたびに
  `reltuples` を読む往復を1回余分に払う。`resetTestDatabase()` の `TRUNCATE` は `reltuples` を `-1` へ戻す
  （ADR 0374 の 2026-09-30 追記。本 ADR の陽性対照のログでも、歯2 の直前に両表が `-1` だった）。
  したがって各 `it` はゲートが未確認の状態から測り始める。**測定の最中に自動 analyze が終わると、
  その後の読みだけ往復が1回減り**、limit ごとの往復数が食い違う。

  ADR 0374 の追記は `recall-roundtrip-count` について「実害は確認されていない」と書いていた。
  本 ADR の観測が、その実害にあたる。

  **観測**:

  - `isolate: false` の構成で、約20回中1回赤になった。
  - main と、手当てだけの版の試走では、24回中0回だった。
  - 過去の失敗ジョブ48本のログに、同じ赤は0件だった（ログが残っている範囲だけなので、下限）。
  - **陽性対照**（試走専用の PR #1487、マージしない）: 歯2 の `beforeEach` で両表の `reltuples` を `-1` に戻す。
    そのうえで、2回目の `reltuples` 読み（limit=5 の測定の中）の直前に、別の接続で `ANALYZE` を打つ。
    - 細工だけ（`17142431`、run 36670637979）: `packages/postgres` の2ジョブ（UTF8・SQL_ASCII）の両方で、
      歯2 だけが `expected 14 to be 15` で赤になった。本番の赤と同じ値である。
    - 下の直しを merge した後（`170e280b`、run 36671166932）: 19ジョブすべて緑。細工は同じく発火した
      （ログに `PROBE: ANALYZE injected before reltuples read #2`）。

- **決めたこと**:

  1. **歯1・歯2・歯4・歯5 は、種まきの後・測定の前に `confirmStatsPresence()` を呼ぶ。**
     両方の表を `ANALYZE` してから、同じ `vectorStore` で `search()` をもう1回打ち、ゲートを確認済みにする。
     ゲートの確認済み集合は増えるだけで減らない（ADR 0374 決定1）。また `runtime` は同じ `vectorStore` の
     インスタンスを使う。したがって以後の測定の中では `reltuples` を読む往復そのものが起きず、
     自動 analyze がいつ終わっても往復数は変わらない。
  2. **歯の主張は弱めない。**許容差（±1）も、比べる limit の削減も、再試行も入れない。
  3. 歯6 は、未確認から確認済みへの移り変わりそのものを測る歯（専用の表）なので、これを呼ばない。

- **採らなかった案**:

  - **往復数に ±1 の許容差を入れる**: 「limit で往復数が変わらない」という主張が「1往復までは変わってよい」に
    弱まる。本物の退行（候補1件ごとに1往復増える、など）も、候補が少なければ1差で見逃す。
  - **失敗したら再試行する**: 赤の原因を消さず、見えにくくするだけである。
  - **測定対象の表の autovacuum を止める**: 自動 analyze の時刻を消しても、ゲートが未確認のまま測ることは変わらない。
    歯が「未確認の状態の往復数」に依存し続ける。

- **確かめていないこと**:

  - 陽性対照は、差し込みの時刻を1点（2回目の `reltuples` 読みの直前）に固定した1通りだけである。
    ただし決定1の理由により、直した後の測定には `reltuples` を読む往復が無いので、差し込みの時刻には依らないはずである。
  - `isolate: false` の構成で、直しを入れた後に何回緑が続くかは、#1472 に main を取り込んだ後の CI で見る。
