# ADR 0415: consolidate / reflect の内部 recall に `scopeAggregate: "skip"` を渡し、使わない件数集計を払わない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30
- **PR**: Draft（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) の続き。`Refs`、閉じない）

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> 案C（`scopeAggregate: "skip"`）を consolidate / reflect の内部に使うと決めたのはオーナーの採った結論（マネージャー経由）であり、
> この文書の文面（対象の洗い出し・測定・変わること／変わらないことの判定）は委譲先が書いた。

---

## 問い

`runtime.consolidate({ target: { seedMemoryId } })` は、中で `recall({ text: seed.digest, activityCounting })` を1回呼ぶ。`scopeAggregate`
を渡さないので `recall-runtime.ts` で既定の `"exact"` になり、`MemoryStore.aggregateScope` の件数集計（Postgres では `GROUP BY subject_id`）が
毎回走る。**consolidate はこの recall の結果のうち `memories` しか使わない。** 100万行では、その集計が consolidate の大半を占める。

## 背景（実測。前の担当が測り、本 ADR の担当が測り直した）

100万行・全件 active・単一テナント・`max_parallel_workers_per_gather=0`・同時1の `consolidate({ seedMemoryId, dryRun: true })`:

| | p50 | うち `aggregateScope` |
|---|---|---|
| 変更前・前の担当の測定（`main` の `e3045d8`） | 893.1 ms | 855.4 ms |
| 変更前・本 ADR の担当が同じ器・同じ設定で測り直した値（同上の `e3045d8`） | 742.9 ms | 700.8 ms |
| 変更後（本 ADR、同じ器・同じ設定） | 6.4 ms | 0.8 ms |

`recall` 単体は、`"exact"` が 905 ms（前の担当）／747.1 ms（今回の同条件の測り直し）、`"skip"` が 5 ms／3.2 ms。条件と限界は下「測ったこと」。

## 決めたこと

### 決定1. 内部の recall のうち、集計の結果を読まない場所すべてに `scopeAggregate: "skip"` を渡す

洗い出し（`packages/core/src/runtime.ts` の `recall(` 呼び出しを全部読み、`runRecall` の呼び出しは `recall` ラッパー1箇所だけであることも確かめた。行番号は本 ADR の時点）:

| 場所 | 集計（`totalInScope`・目次帯・`filtered*`・`omitted`・`explain`）を読むか | 扱い |
|---|---|---|
| `consolidate` `{ seedMemoryId }`（7521 行付近） | 読まない（`memories` の id と `score` だけ） | **skip を渡す** |
| `consolidate` `{ query }`（7545 行付近） | 読まない（`memories` の id だけ） | **skip を渡す。ただし利用者が `query.scopeAggregate` を明示していたらその値を尊重** |
| `reflect` `{ seedMemoryId }`（8023 行付近） | 読まない | **skip を渡す** |
| `reflect` `{ query }`（8047 行付近） | 読まない | **skip を渡す（`consolidate` と同じ尊重の規則）** |
| tick の `processConsolidateJob` / `processReflectJob`（5661〜5706 行付近） | 自分では `recall` を呼ばず `consolidate` / `reflect` の `{ seedMemoryId }` を呼ぶ | 上の2行で足りる（個別の変更なし） |
| `findCorrectionCandidates`（6016 行付近） | **読む**（`omitted`・`explain`・`recallId` をそのまま利用者へ返す） | **変えない** |
| 公開 `runtime.recall()` | 利用者のもの | 変えない |

`{ query }` 形は利用者の `RecallQuery` をそのまま使う口なので、`{ ...target.query, scopeAggregate: target.query.scopeAggregate ?? "skip" }`
とし、利用者が `"exact"` を明示したときは上書きしない。公開 API の型・`ConsolidateTarget` / `ReflectTarget` は変えていない
（`scripts/__snapshots__/public-api` に差分なし、`pnpm api:check` 緑）。

### 決定2. 歯は、`aggregateScope` の呼び出しの `scopeAggregate` を数える

`packages/core/src/__tests__/consolidate-reflect-skip-scope-aggregate.test.ts`。`FakeMemoryStore` を Proxy で包み、`aggregateScope` の第3引数を記録する。
consolidate・reflect の `{ seedMemoryId }`・`{ query }`（明示なし／`"exact"` 明示）、tick の2ジョブ、そして逆側（直接の `recall()` と
`findCorrectionCandidates` は `"exact"` のまま）を縛る。

## 歯（先に書いた。赤→緑）

歯だけの commit `8d996d7`（実装の前）と、実装の commit `1d04950` を分けた。`8d996d7` は `git push` 済み。

- `8d996d7`（実装前）: 8件中 **5件が赤**。`consolidate の { seedMemoryId } 形`・`reflect の { seedMemoryId } 形`・`consolidate の { query } 形`・`reflect の { query } 形` は
  `expected [ 'exact' ] to deeply equal [ 'skip' ]`、`tick の consolidate / reflect ジョブ` は `expected [ 'exact', 'exact' ] to deeply equal [ 'skip', 'skip' ]`。
  緑のまま残った3件は「`{ query }` で利用者が `exact` を明示したら尊重」2件と「直接の `recall()` と `findCorrectionCandidates` は `exact`」——実装後も変わってはならない側。
- `1d04950`（実装後）: 8件すべて緑。既存の consolidate / reflect / runtime / correction-candidates / abort-signal / validity-gate 系 10ファイル 288件も緑。

## 手順0: `"exact"` → `"skip"` で何が変わるか

**結論: consolidate / reflect の返り値は変わらない。変わるのは、内部の recall が書く `recalls` 行の中身（と、その行を `getRecall` で読んだときの診断）である。**

### 変わらないもの

- **consolidate / reflect の返り値。** どちらも `recallResult` から `memories` だけを取り出し、`recallId`・`omitted`・`explain`・`index` は返り値に載せない
  （`runtime.ts` の該当4箇所）。実物: 100万行の DB（`agg1m`）の `consolidate({ seedMemoryId, dryRun: true })` の返り値は、変更前と変更後で同じ
  （`outcome: "nothing_to_consolidate"`、`nothingReason: "single_eligible_source"`、`sources` 1件）。
- **`memories`（近傍の選び方）。** 段1〜4の結果は段5（集計）より前に確定しており、集計の有無は `finalMemories` に影響しない
  （`recall-runtime.ts` 段5は `finalMemories` を読むだけ。`digestBand` の除外にだけ使う）。
- **目次帯の中身（`digestBand` の各エントリ）。** 取得は件数集計と別の経路（`ORDER BY ... LIMIT`、ADR 0384 案A の索引）。実物で、同じ条件の recall を `"exact"` と `"skip"` で打ち、
  `digestBand` の `memoryId` の並びが一致することを確かめた（40件）。
- **`createRecall` に渡る `budget`・`returnedMemories`・`advanceActivityClock`（活動時計を進めるか）。** `skip` は集計の段だけを替える。

### 変わるもの（`recalls` 行と診断）

100万行の DB に対し、同じ `{ text }` の recall を `scopeAggregate: "exact"` と `"skip"` で打ち、`getRecall` で読み比べた（実物。`/tmp/mgr-782e4b75-pg/rowdiff.json`）:

| `recalls` 行の欄 | `"exact"`（変更前の consolidate / reflect） | `"skip"`（変更後） |
|---|---|---|
| `query` | `{ text, [activityCounting] }`（consolidate 内部の呼び出しは `scopeAggregate` を渡さないので、キー自体が無い） | `{ text, [activityCounting], scopeAggregate: "skip" }`（キーが1つ増える） |
| `omitted` の `filtered(decayed/archived/...)` | 件数つきで積まれる（実物: `decayed` 1,000,001件） | **積まれない** |
| `omitted` の `not_indexed(pending/failed/skipped)` | 積まれる（実物: `pending` 980,000件） | **積まれない**（件数が `0` のため） |
| `omitted` の `ann_unreached` | 判定される | **判定されない** |
| `indexBand.groups` | subject ごとの群（実物: 10,001群） | `[]` |
| `indexBand.totalInScope` / `countKind` | 実数 / `"exact"` | `0` / `"unknown"` |
| `indexBand.digestBandCoverage` | `eligible` は実数・`countKind: "exact"` | `eligible: 0`・`countKind: "unknown"`（`shown` と帯の中身は同じ） |
| `explain.stages` の `index_band` の `detail.totalInScope` | 実数 | `0` |
| `explain.stages` の ANN（`candidate_generation`）の `detail` | キーなし | `annReachability: "unknown"`（ADR 0390。ANN の段が走ったときだけ） |
| `usage.indexChars`・`usage.byTier.index`・`usage.chars` | 集計の群を含めた量（実物: 685,122） | 帯だけの量（実物: 4,153） |

**利用者が観測できる振る舞いが変わるか**: consolidate / reflect の返り値は変わらない。変わるのは `recalls` 行（`runtime.getRecall(ctx, recallId)` や DB の `recalls` 表）の
うち、consolidate / reflect が内部で書いた行だけである。その `recallId` は consolidate / reflect の返り値に載らないので、利用者がこの行を見るのは
`recalls` 表を直接読む・監査するときに限られる（`getRecall` は `recallId` を知っていれば読めるが、知る経路が返り値に無い）。**その意味で観測できる変化はある**ので CHANGELOG に載せる。
公開 API の型・DB の schema は変えていない。

行の欠落は「嘘」にならない形で名乗られる: `countKind: "unknown"` と `annReachability: "unknown"` が「数えていない」を明示する（ADR 0384 決定7、ADR 0390）。

## 採らなかった案

- **`ConsolidateTarget` / `ReflectTarget` に `scopeAggregate` の欄を公開する案**: 公開面が増える。利用者が判断できる材料（自分の consolidate が100万行で何を払っているか）は薄く、
  既定で払わないほうが安全。今回は見送り。`{ query }` 形だけは、もともと利用者の `RecallQuery` なので、明示した値を尊重する形で残した。
- **ADR 0384 の事前カウンタ表の案**（件数を書き込み時に表へ保つ）: 書き込み経路と整合の維持が要る。この変更は「そもそも読まない」ので、そちらを待たずに済む。見送り。
- **集計を止めず、並列クエリ（`max_parallel_workers_per_gather`）だけで速くする案**: 100万行で 893 → 406（2）→ 269（4）ms と効くが、集計自体は払い続ける
  （`packages/postgres/README.md` の運用の指針に書いた）。本 ADR の 6.4 ms とは桁が違う。**両立する**（集計が走る経路には並列が効く）。
- **`findCorrectionCandidates` も `"skip"` にする案**: `omitted`・`explain` を利用者へ返すので、説明力を手放すことになる。変えない。

## 確かめていないこと

- **`"skip"` を honor しない自前の `MemoryStore`**（`scopeAggregate` を実装しない adapter）は、`"exact"` を返し続けるので、この変更の効果（性能）は出ない。結果は変わらない。
- **`recalls` 行を読んで使う下流**（監査の画面・分析）が `totalInScope` や `filtered*` を当てにしているかは、repo の中では見つかっていない（`getRecall`・`index_band` を読む src は core / postgres / testkit の型とマッピングだけ）が、
  利用者側の自前の読み手までは分からない。
- **同時実行・他の負荷の下**の効果（load average 23〜32 の共有機で測ったが、同時に複数の consolidate を走らせた測定はない）。測ったのは同時1のみ。
- **`recalls` の INSERT のサイズ**が減る効果（`index_band` の `groups` が空になる。10,001群の JSON を書かなくなる）は、時間としては分けて測っていない（consolidate の p50 6.4ms に含まれる）。
- Postgres 以外の adapter（testkit の in-memory など）の実測はしていない。in-memory の `aggregateScope` が `"skip"` を honor するかは本 ADR では確認していない。

## 測ったこと

- **器**: PostgreSQL 17.11、自分専用のインスタンス（`dynamic_shared_memory_type=mmap`）、`shared_buffers=2GB`・`max_worker_processes=16`・`max_parallel_workers=8`。32 vCPU の共有機で、
  測定時の load average は 23〜32。`agg1m`（100万行・全件 active・単一テナント）。単発の接続、同時1。`consol.mts`（10往復、先に2回ウォームアップ）。
- **変更後**（`max_parallel_workers_per_gather` 0・2・4 の3通り。PGOPTIONS で接続ごとに指定）: consolidate の p50 は 6.4・5.9・5.9 ms。`aggregateScope` は 0.8・0.7・0.7 ms。
  すべて件数集計の文は撃たれていない（consolidate の文の内訳は、ANN の SELECT・`recalls` の INSERT・digest の SELECT・`memories` の読みだけ）。
- **変更前**（`e3045d8` の `runtime.ts` に一時的に戻して、同じ DB・同じ `shared_buffers=2GB` で同じ `consol.mts` を回した。変更後の直前・直後に続けて測ったが、交互ではない）:
  consolidate の p50 は並列0・2・4 で 742.9・309.7・219.4 ms（`aggregateScope` は 700.8・275.5・183.9 ms）。前の担当の 893.1 ms（並列0）とは、器の負荷・`shared_buffers` の違いで約150 ms ずれた。
  参考に、同じ器で `aggregateScope` の直接の `"exact"` は 538・205.1・156.9 ms、`recall` の `"exact"` は 747.1・325.6・213.2 ms。
- **前後の比**（同条件の並列0）: 742.9 → 6.4 ms。共有機（load average 23〜32）で、各10往復の p50 どうしを並べただけである。交互に測っておらず、IQR も取っていない。
  **桁が変わったこと**（約2桁）は言えるが、倍率の有効数字は主張しない。
- **並列クエリとの関係**: 変更前は並列を上げると速くなる（742.9 → 309.7 → 219.4 ms）が、変更後は集計を撃たないので並列の有無で差が出ない（6.4・5.9・5.9 ms）。

## これが覆るとしたら何が起きたときか

- consolidate / reflect が recall の `omitted`・`index` を返す、または使う変更が入ったとき（その場合は、読む側だけ `"exact"` に戻す）。
- `recalls` 行の `index_band` を consolidate / reflect の監査で使う要望が出たとき。

## 関連

- [ADR 0384](./0384-digest-band-index-and-scope-aggregate-skip.md)（案C の `scopeAggregate`）、[ADR 0390](./0390-ann-unreached-aware-of-excluded-provenance-and-skip.md)（`annReachability: "unknown"`）
- [ADR 0401](./0401-mark-resolve-contested-group-constant-statements.md)・[ADR 0402](./0402-relation-store-list-related-many.md)（Issue #1449 の続き）
