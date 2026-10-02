# ADR 0519: testkit の InMemory の `reinforce` が purge 済みの記憶をどう扱うかを実測した — Postgres と同じだった（割れなし。歯を足し、TSDoc の「測っていない」を書き換えた）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先の担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元の Postgres 17 で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0501](./0501-doc-debts-usage-env-analyze-per-process-reinforce-purged.md) の「引き受けた負債」3は、`MemoryStore.reinforce` の TSDoc に purge 済みの扱いを書いたとき、InMemory 側を測っておらず「測っていない」と書いた。測って、Postgres と違えば InMemory を揃える、という負債だった。

## 決めたこと

### 1. 2者に同じ入力を流す歯を足す

【実測】`packages/postgres/src/__tests__/store-reinforce-purged-checks.postgres.test.ts`（`store-status-write-checks.postgres.test.ts` と同じ書き方。testkit の InMemory と Postgres を並べ、同じ入力を流して戻り値・例外・状態を見る）。入力は、`updateStatus(forgotten)` → `purgeMemory` で作った purge 済みの記憶に対する次の4つ。

- `reinforce`: 例外を投げない。戻り値と読み戻しの両方で `lastReinforcedAt` が `at` になり、`decayFloorAt` が進む。`status`（`forgotten`）・`purgedAt`・`content`・`digest`（どちらも `[purged]`）は不変。`memory_events` の件数も不変。
- `reinforce`（起点以前の `at`）: no-op（Issue #1093）で、戻り値は現在の行。purge 済みでも変わらない。
- `reinforceMany`: purge 済みを含んでも例外を投げず、全件を書き換える。
- `recordUsageAndReinforce`: 使用の行が挿入され（`insertedMemoryIds` に入る）、`lastReinforcedAt` が書き換わる。

【実測】8 本（2者 × 4）。**InMemory も Postgres も同じ結果で、割れは無かった。**【現物】InMemory の `reinforce` は `purgedAt` を見ない。Postgres の `reinforce` も `purged_at` を条件に持たない。同じ形。

### 2. TSDoc の「InMemory 側は測っていない」を実測の結果に書き換えた

`packages/core/src/interfaces/memory-store.ts` の `reinforce` の purged の箇条。「InMemory も同じ」と、歯と本 ADR への参照を書いた。**`Runtime.observe({ kind: 'memory_usage' })` 経由は InMemory では測っていない**ので、そう書いた。

### 3. 実装・fixture は変えていない

割れが無かったので、InMemory にも Postgres にも手を入れていない。断る入力は増えない。CHANGELOG・`docs/migration-v1.md` は変えていない（fixture を変える直しではないので、🟡 の項目も足していない）。conformance suite（ADR 0434 決定5）にも足していない。

## 変異試験【実測】

- InMemory の `reinforce` に「`purgedAt` があれば何も書かず現在の行を返す」を足す → InMemory 側の3本が赤（`reinforce`・`reinforceMany`・`recordUsageAndReinforce`。no-op の1本は元から no-op なので緑）。戻して緑。
- **Postgres 側の変異は撃っていない**【未確認】。Postgres で purged を弾く変異は、ADR 0501 の歯（`reinforce-purged-memory.postgres.test.ts`）が `reinforceMany` 経由で撃っている。この歯が Postgres に足すのは、単体の `reinforce` の戻り値と、InMemory との一致。

## 手元で走らせたもの【実測】

Postgres 17（pgvector 入り、自分専用のインスタンス）で、`store-reinforce-purged-checks.postgres.test.ts` と `reinforce-purged-memory.postgres.test.ts` を UTF8 で 10 本とも緑。`store-reinforce-purged-checks` は SQL_ASCII でも 8 本緑。

## 採らなかった案

1. **InMemory に purge 済みを弾く分岐を足す。** 割れが無いので不要。Postgres も弾かない。弾くなら store の約束の変更で、オーナーの領分（ADR 0501 案3）。
2. **conformance suite に purge 済みへの強化を足す。** 採らなかった。ADR 0434 決定5 の領分。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | `Runtime.observe({ kind: 'memory_usage' })` 経由の purge 済みへの強化を、InMemory で測っていない | InMemory の記憶で `forget` → `purge` → `observe(memory_usage)` を流し、`lastReinforcedAt` を見る | Postgres と違えば fixture の差（🟡） | 低 | 測ったとき |
| 2 | Postgres の単体 `reinforce` を弾く変異は撃っていない | `PostgresMemoryStore.reinforce` に `purged_at IS NULL` を足す | 新しい歯が赤になるはず | 低 | 測ったとき |

## これが覆るとしたら

オーナーが「purged には強化を書かない」を store の約束にしたとき（TSDoc の箇条と、ADR 0501・本 ADR の歯を書き換える。2者を揃えて断る入力が増えるので、CHANGELOG の Breaking と migration-v1 の 🔴 に書く）。

## 測っていないこと

上の負債の2件。`tenantId` をまたぐ（別テナントの purge 済みの記憶への）強化。`halfLifeRecalls` を持つ記憶に `nowSeq` を渡す形での purge 済みへの強化（活動時計の欄）。
