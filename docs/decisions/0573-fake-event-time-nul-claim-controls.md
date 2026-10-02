# ADR 0573: ADR 0563 の歯が通した4つの変異（`updatedAt` の時刻・`extractorVersion` の NUL・claim predicate の並び）を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-f9bd8ced の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで。`C.UTF-8`）、【判断】は担い手の判定。

## 経緯【現物】

[ADR 0563](./0563-core-fake-event-time-nul-and-claim-predicates.md)（PR #1676）の歯を、独立の検証が変異で確かめ直した。対象は `packages/core/src/__tests__/runtime-fakes.ts` で、次の4つが生き残った（赤0本）。

| 変異 | 内容                                                                               | 本物の挙動                                                                                                                         | すり抜けた理由                                                                                                             |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A2   | `archiveDecayed` の `memory.updatedAt` を `new Date(opts.now)` にする              | Postgres は `updated_at = now()`（壁時計）。`archived` イベントの `at` だけが `opts.now`                                           | 歯は `archived` の `at` だけを見て、行の `updatedAt` を読んでいなかった                                                    |
| P2   | `purgeMemory` の `updatedAt` を `new Date(at)`（`event.at`）にする                 | Postgres は `updated_at = now()`。`purged_at` だけが `event.at`                                                                    | 歯は `purgedAt` と `event.at` だけを見ていた                                                                               |
| N5   | `createMemory` に `assertWellFormedIdentifier(input.extractorVersion, ...)` を足す | `extractorVersion` は識別子ではなく `text` の欄。NUL は InMemory・Postgres とも素の `Error`（`MalformedIdentifierError` ではない） | 歯は `subjectId`・`externalId` の NUL だけで、識別子でない欄が素の `Error` のままであることを縛る入力が無かった            |
| C6   | `listActiveClaimPredicates` の並びを `b[1]-a[1]` から `a[1]-b[1]`（古い順）にする  | Postgres は `ORDER BY MAX(created_at) DESC, claim_key_predicate COLLATE "C" ASC`                                                   | 既存の歯の題は「新しい順、同着は predicate の順」だが、本体は `result.sort()` をかけてから比べており、並びを見ていなかった |

生き残りは**どれも Fake のバグではなく、歯の穴**だった。`runtime-fakes.ts` は触っていない。

## 実測【実測】

Postgres（`PostgresMemoryStore`）と testkit の `InMemoryMemoryStore` に、同じ入力を通して確かめた（使い捨ての試験で、commit には含めない）。

- `archiveDecayed(ctx, { now: 2031年, limit })` の後、`get(id).updatedAt` は呼ぶ前と後の間の壁時計（両実装とも）。
- `purgeMemory` に `event.at = 2020年` を渡すと、`purgedAt` は 2020 年、`updatedAt` は呼ぶ前と後の間の壁時計（両実装とも）。
- `createMemory` に `extractorVersion: "v\u0000"` を渡すと、`isMalformedIdentifierError` は偽で、message は `PostgresMemoryStore: extractorVersion must not contain NUL characters (U+0000)`（InMemory は `InMemoryMemoryStore:` で始まる同じ文面）。Fake の接頭辞は `FakeMemoryStore:`。
- `listActiveClaimPredicates` は、作成時刻の異なる2行で `["newer", "older"]`（両実装とも）。Postgres で `created_at` を揃えると、同着は predicate の順（`["newer", "older"]`）。

InMemory・Postgres・Fake の食い違いは無かった。

## 決定【判断】

1. 歯を新しいファイル `packages/core/src/__tests__/fake-event-time-nul-claim-controls.test.ts`（7 本）に足す。
   - `updatedAt` は壁時計: `archiveDecayed`（`opts.now` が 2031 年）と `purgeMemory`（`event.at` が 2020 年、`purgedAt` は `event.at`）で、`updatedAt` が呼ぶ前と後の間に入る。
   - `createMemory` の `extractorVersion` の NUL は `isMalformedIdentifierError` でなく、`/extractorVersion must not contain NUL/` の素の `Error`（何も書かない）。対照: NUL の無い値は通る。
   - `listActiveClaimPredicates` の並び: 作成時刻の異なる2行で新しい順（`limit: 1` も）、同じ predicate の複数行は最新の行の時刻で並ぶ、同着は predicate のコードポイント順（挿入の順ではない）。時刻は `vi.useFakeTimers({ toFake: ["Date"] })` と `setSystemTime` で作る。
2. 既存の `fake-list-claim-predicates-partial-claim-key.test.ts` の「新しい順、同着は predicate の順」の題は、実際より強い。**直さずに残し、新しい歯で補う**（既存の core テストを触る量を最小にするため。題は、片側だけの claim key を数えないことを縛る歯の対照としては用が足りている）。並びはこの ADR の歯が持つ。
3. `runtime-fakes.ts` は変えない。CHANGELOG は変えない（テストと文書だけで、出荷物に触れない）。

## 変異試験【実測】

歯を commit してから、変異を1つずつ入れて（退避は `cp`、戻すのも `cp`）、新しい歯を走らせた。

| 変異                                                                            | 赤の本数（新しい 7 本のうち）               | 戻して緑 |
| ------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| A2: `archiveDecayed` の `updatedAt = new Date(opts.now)`                        | 1（`archiveDecayed` の `updatedAt`）        | 7 本緑   |
| P2: `purgeMemory` の `updatedAt = new Date(at)`                                 | 1（`purgeMemory` の `updatedAt`）           | 7 本緑   |
| N5: `createMemory` に `assertWellFormedIdentifier(input.extractorVersion, ...)` | 1（`extractorVersion` の NUL）              | 7 本緑   |
| C6: `listActiveClaimPredicates` の並びを古い順に                                | 2（2行の新しい順、同じ predicate の複数行） | 7 本緑   |

C6 で同着の歯が赤にならないのは意図どおり（同着は時刻の向きに依らない）。同着の歯は、時刻の比較を落とす変異（predicate の順だけで並べる実装）と、挿入の順で並べる実装を縛る。この2つの変異は入れていない（【未確認】）。

## 採らなかった案

- 既存の `fake-list-claim-predicates-partial-claim-key.test.ts` の本体を `result.sort()` なしに書き直す。題と本体の食い違いは直るが、既存の core テストを触る量が増え、並びの歯は1か所（新しいファイル）にまとまっているほうが読める。
- `updatedAt` の歯を `vi.useFakeTimers` で固定の時刻にする。呼ぶ前と後の間（`Date.now()` で挟む）なら、変異（2031 年・2020 年）が壁時計の近傍の外へ出ることで足りる。固定の時刻だと、実装が `Date` を何回読むかに縛られる。

## これが覆るとしたら

[Issue #768 のコメント2](https://github.com/takecchi/mnemora/issues/768)の方針（Fake を適合テストに通さず、直したものは専用の `fake-*.test.ts` で縛る）が変わるとき。そのときは、これらの歯は適合テストに置き換わる。
