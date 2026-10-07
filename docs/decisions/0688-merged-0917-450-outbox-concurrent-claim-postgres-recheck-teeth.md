# ADR 0688: 09/17 にマージされた #450（outbox の同時 claim の適合テスト）の Postgres 側の確かめ直しで見つかった穴に歯を足す（Issue #1812、まとまり G5 の Postgres 側）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1812](https://github.com/takecchi/mnemora/issues/1812)。in-memory 側（testkit の歯）は PR #1818 で済んでいる。残っていた Postgres 側（`conformance.postgres.test.ts` が `PostgresOutboxStore` に並行の適合テストを本当に走らせているか）を、手元の Postgres 17 + pgvector（[ADR 0183](./0183-local-postgres-makes-postgres-mutation-testing-possible.md) の手順）で測った。
試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異は控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。

## 経緯【実測】

main `957491cc` の上で、`packages/postgres/src/outbox-store.ts` の `claimBatch`（ロック句・WHERE・LIMIT・UPDATE の SET）に18本、適合テストの配線（`conformance.postgres.test.ts` の `supportsRealConcurrency`、`test-db.ts`・`client.ts` の pool の `max`）に5本、「やりすぎ」（テナントの候補を全部ロックしてから LIMIT）に1本、計24本を1本ずつ当てた。「前」は、outbox の適合（`conformance.postgres.test.ts` の OutboxStore の部分）と outbox・tick の既存7ファイル（`outbox-skip-locked-non-blocking`・`outbox-head-of-line`・`outbox-first-terminal-wins`・`outbox-complete-fail-terminal-exclusive`・`outbox-claim-statement-failure-recovery`・`tick-sequential-redelivery`・`tick-mixed-kinds-concurrency-lease-parity`）で測った。

当てた約束は ADR 0206（と ADR 0208・0531 の追記）の今の形である。`true` を渡した adapter では「同時に撃った `claimBatch` が同じジョブを二重に claim しない」を8並行・10ラウンドで見る。合計の本数は見ない（拾い残しは次の tick が拾う）。二重 claim を止めるのは `FOR UPDATE` の行ロックで、`SKIP LOCKED` は「詰まらないこと」（ADR 0208 の歯）。

## 結果【実測】

並行の `it` が赤にした変異: `FOR UPDATE SKIP LOCKED` を丸ごと削る（duplicateRounds 7〜10）、`FOR SHARE SKIP LOCKED`、`FOR KEY SHARE SKIP LOCKED`、`FOR UPDATE NOWAIT`（並行で `55P03`）、リースの条件を丸ごと外す。`SKIP LOCKED` だけ外す変異は並行の `it` では緑で、ADR 0208 の歯が赤にする（ADR 0206 のとおり）。ほかの WHERE・LIMIT・SET の変異は、適合の逐次の歯・outbox の既存の歯が赤にした（`claimed_by` を固定値にする変異だけは、outbox の適合では緑で、`tick`・`store-boundary-diff` 系の既存の歯が赤にした）。
等価: `FOR NO KEY UPDATE SKIP LOCKED`（`UPDATE` が取るロックと同じ強さで、結果は同じ）。
約束に無いので歯にしない: テナントの候補を全部ロックしてから LIMIT する形（並行下で拾い残しが増える）。ADR 0206 決定2が拾い残しを許容しているので、全部緑でよい。

穴は配線の5本（前は全部、並行の `it` が緑のまま）。

- `supportsRealConcurrency: true` を渡さない／`false` にする → 並行の `it` が skip になるだけで、赤になるものが無かった。この変異と「`FOR SHARE SKIP LOCKED`」を重ねても、並行の `it` が skip になるぶん outbox の適合は緑で、`tick-multi-pool-concurrency` が別の形で赤にするだけだった。
- 適合が使う共有 pool の `max` を 1 や 7（並行数 8 未満）にする → 並行が実際には重ならず、壊れた実装でも並行の `it` は緑になりうる。`max: 1` は無関係な1本が偶然赤にしただけで、`max: 7` は緑。

足した歯は新規1ファイル `packages/postgres/src/__tests__/outbox-concurrent-claim-wiring.postgres.test.ts` の3本。

- Postgres の OutboxStore 適合の並行の `it` が `skip` でなく `run` で登録される（適合の suite を取り込み、登録された task の mode を読む。取り込んだ suite は走らせない）。
- 共有 pool の `max` が並行数以上。
- 共有 pool で並行数ぶん同時に撃った文が、別々のバックエンドで時間的に重なる。
  全部、変異で赤・戻して緑・`cmp` 一致。緑は5回連続で安定した。縛りは ADR 0206 の約束（並行を測れる状態で走らせる）だけで、ラウンド数・並行数の値や `claimBatch` の SQL には触れない。

## 決定【判断】

1. 実装・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験だけである。
2. 並行の `it` が実際に二重 claim を捕まえることは、既存の歯と上の変異で確かめられたので、判定側には歯を足さない。
3. 実バグは無し。

## 確かめていないこと

- ADR 0206 の負債（複数プロセス・別 `Pool`）。並行の適合は共有の単一 `Pool` までで、別 `Pool` は ADR 0531 の `tick-multi-pool-concurrency` が `tick` の水準で見ている。別ホストは測っていない。
- testkit 側の定数（ラウンド数・並行数・`limit`）を変える変異を Postgres に当てたことは無い。in-memory の偽 store での歯（PR #1818）に任せた。
- 「ロックを強めて詰まらせる」形のうち、`FOR UPDATE NOWAIT` と ADR 0208 の外部ロックを超える形（アドバイザリロックでの直列化など）は当てていない。
- `outbox-concurrent-claim-wiring` が別の適合 suite の取り込みに依存する: vitest の取り込みの仕様が変わると、この歯は登録の数（`["run"]`）で赤くなる。
- 全テストは流していない。関係するファイルを明示して走らせた。
