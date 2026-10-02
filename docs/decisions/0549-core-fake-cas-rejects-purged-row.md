# ADR 0549: core の Fake の CAS（`expectedStatus`）も、purge 済みの行を弾く（InMemory・Postgres と揃える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-c6db44c8 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 割れ【現物・実測】

- 約束: [ADR 0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md) は、purge 済みの行（`status` は `forgotten` のまま `purgedAt` が非 null）を、どの `expectedStatus` にも一致しないものとして `MemoryStatusConflictError` で断るようにした（`PostgresMemoryStore` の `expectedStatusCondition`、testkit の `InMemoryMemoryStore` の `casMismatch` = `status !== expectedStatus || (purgedAt ?? null) !== null`）。[ADR 0518](./0518-status-conflict-error-purged-row-doc.md) はこれを `MemoryStatusConflictError` の TSDoc に書いた（0518 は core の Fake を「触っていない」と書いて範囲の外に置いた）。
- 割れ: `packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` の CAS は `memory.status !== expectedStatus` しか見ず、`purgedAt` を見ていなかった。purge 済みの行に `expectedStatus: "forgotten"` を渡すと、弾かれずに書き換わった。
- 割れていた4か所（`runtime-fakes.ts`）: `updateStatus`、`updateStatusWithEvent`、`supersedeWithNewMemories` の事前判定（[ADR 0469](./0469-fake-event-target-and-uuid-case.md) の willSupersede の走査）、同 本処理（弾かれたら `conflicted` に積む）。

## 決定【判断】

1. Fake にも InMemory と同じ式の `casMismatch` を置き、上の4か所に当てた。例外（`MemoryStatusConflictError(id, expectedStatus, memory.status)`）と `conflicted` の `observedStatus`（`memory.status`）の値は変えていない。InMemory と同じ。
2. **事前判定（willSupersede の走査）も直す範囲に入れた理由**: 入れないと、purge 済みの対象が事前判定を素通りして `event.memoryId` の検査（ADR 0469）を受け、その後の本処理で弾かれる、というずれが残る（検査に通らないイベント先なら、弾かれる対象なのに例外になる）。InMemory は同じ箇所で `purgedAt` を見て揃えている。
3. 同じ呼び出しで先に superseded にした対象（willSupersede に入っているもの）は、従来どおり status を `superseded` として比べる（purge 済みの行は CAS を通らないので willSupersede に入らない）。
4. **CHANGELOG と migration-v1 は書かない**: Fake は core の `src/__tests__/` にあるテスト専用で、公開していない（パッケージの出荷物に入らない）。
5. 公開 API・型・testkit・Postgres は触っていない。

## 歯と実測【実測】

- 歯: `packages/core/src/__tests__/fake-cas-purged-row.test.ts`（5 本）。purge 済みの行は `runtime.forget` → `runtime.purge` で作る。(1) `updateStatus` が `MemoryStatusConflictError` で弾かれ行が変わらない。(2) `updateStatusWithEvent` も同じで、イベントが積まれない。(3) `supersedeWithNewMemories` で purge 済みの対象が `conflicted`（`observedStatus: "forgotten"`）に入り、status もイベントも変わらない。(4) 事前判定: purge 済みの対象の `event.memoryId` を別テナントの記憶にしても、検査されず例外にならない。(5) 対照: purge していない forgotten の行は `expectedStatus: "forgotten"` で通る。
- 直す前の赤: 5 本中 4 本が赤（(1)〜(4)。(5) は緑）。(1)(2) は `MemoryStatusConflictError` でなく通ってしまう、(3) は `conflicted` が空、(4) は `FakeMemoryStore: memory not found for tenant` で例外。直した後は 5 本とも緑。
- 変異試験（purgedAt の判定を外し `status !== expectedStatus` だけに戻す。1か所ずつ。戻した後は緑）:

| 変異した箇所 | 赤になった it |
|---|---|
| `updateStatus` | (1) |
| `updateStatusWithEvent` | (2) |
| `supersedeWithNewMemories` の事前判定 | (4) |
| `supersedeWithNewMemories` の本処理 | (3)・(4)（本処理だけ外すと、purge 済みの対象が事前判定で検査に回り、(4) も赤） |

- 既存の歯: core の歯に、Fake が purge 済みの行の `expectedStatus` を通すことへ頼るものは無かった。名指しで走らせた 21 ファイル（fake-event-target-belongs-to-ctx-tenant・purge・outcome-error-format・recall-basis-lost・runtime-branch-teeth・fake-uppercase-target-id・forget・fake-memory-store-supersede-with-new-memories・fake-store-postgres-parity・tsdoc-edges 系・Fake の conformance 系など）は 411 本とも緑。全テストは走らせていない。

## 採らなかった案

- 事前判定を直さず3か所だけ直す。上の理由（ずれが残る）で採らなかった。
- `casMismatch` を testkit から共有する。core は testkit に依存しない（`dependency-boundary`・各テストの注記）ので、式を Fake に置いた。式の写しが2つになる負債は、本 ADR の歯（Fake 側）と testkit 側の既存の歯で見張る。

## これが覆るとしたら

purge 済みの行の `expectedStatus` の扱いを ADR 0499 が変える（たとえば `purgedAt` を CAS から外す）とき。そのときは3実装を一緒に直す。
