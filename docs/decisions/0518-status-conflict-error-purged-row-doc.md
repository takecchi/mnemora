# ADR 0518: `MemoryStatusConflictError` の TSDoc に、purge 済みの行では `expectedStatus` と `observedStatus` が両方とも `"forgotten"` になることを書く（文書だけ）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先の担い手が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所: [ADR 0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md)「引き受けた負債」の 3（`MemoryStatusConflictError` の `expectedStatus` と `observedStatus` が、purge 済みの行でどちらも `"forgotten"` になる。例外を見ただけでは「purge 済みだから」と分からない）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果（Node.js、Postgres 17 + pgvector を自分専用のポートで、UTF8）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0499 は、purge 済みの記憶への `expectedStatus` 付きの更新を、既存の `MemoryStatusConflictError` で断るようにした。`expectedStatus: "forgotten"` で呼ぶと、purge 済みの行の `status` も `"forgotten"` のままなので、例外は `expectedStatus` も `observedStatus` も `"forgotten"` になる。この読みにくさは、ADR 0499 が負債として積んだままだった。

- **現物の確認**【現物・実測】:
  - TSDoc（`packages/core/src/interfaces/memory-store.ts` の `MemoryStatusConflictError`）に、この振る舞いの記述は**無かった**（`observedStatus` が「弾かれた後に読み直した値」である注意書きだけ）。
  - 振る舞いは今も本当にそうである。`packages/postgres/src/memory-store.ts` の CAS 違反の例外は、`UPDATE … WHERE status = expected AND purged_at IS NULL`（purge 済みを一致させない）が0行のとき `row.status` を読み直して詰める（purge 済みなら `"forgotten"`）。【実測】既存の歯 `store-status-write-checks.postgres.test.ts`（InMemory と Postgres の2実装）は `expectedStatus` が `"forgotten"` であることしか見ていなかったので、`observedStatus` も `"forgotten"` であることを足して走らせた: 14 本とも緑（`-t "purge 済みの行は expectedStatus"`、UTF8）。

- **決めたこと**【判断】:
  1. `MemoryStatusConflictError` の TSDoc に、purge 済みの行（`status` が `"forgotten"` のまま `purgedAt` が入った行）では `expectedStatus: "forgotten"` のとき両方が `"forgotten"` になること、例外だけでは purge 済みと分からないこと、`Memory.purgedAt` を読み直すこと、`purge` の CAS 違反は別の型（`MemoryPurgeConflictError`）であることを書いた。
  2. **挙動は変えない。公開 API・型・例外クラス・conformance suite は触らない。**
  3. 書いた振る舞いを縛る歯として、`store-status-write-checks.postgres.test.ts` の2本（`updateStatusWithEvent`・`updateStatus`）に `observedStatus` の assertion を足した（テストの追加だけ。実装は変えない）。

- **採らなかった案**:
  1. **例外に `purged` の印（欄）を足す、`MemoryPurgeConflictError` を使う。** 公開 API の変更で、オーナーの領分（ADR 0499 の採らなかった案も同じ）。
  2. **CHANGELOG に書く。** コメント・TSDoc だけの変更は、既存の慣例（CHANGELOG「何を載せるか」）で項目にしていない。Documentation の項は CHANGELOG に無い。

- **変異**【実測】: CAS 違反の例外に詰める `observedStatus` を `"active"` に固定する（`memory-store.ts` の `row.status` の箇所）→ 足した assertion の2本が赤（14 本中 2 本）。戻した後は緑。

- **引き受けた負債**: 例外自体の読みにくさは残る（TSDoc で補っただけ）。直すなら、例外に purge 済みを示す欄を足すか専用の型を使う（公開 API の変更。オーナーが決めること）。

- **測っていないこと**【未確認】: SQL_ASCII の DB での実測（TSDoc の文面は encoding に依らない。status の比較だけの経路）。core の `FakeMemoryStore`（テスト専用で、ほかの担当が触っているため触っていない）の振る舞い。
