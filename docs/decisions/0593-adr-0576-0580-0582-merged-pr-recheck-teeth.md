# ADR 0593: マージ済みの #1688〜#1694 の確かめ直しで見つかった、やりすぎ側の穴4つを塞ぐ（ADR 0576 の TSDoc 2つ・ADR 0580・ADR 0582）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) などの試験だけの PR と同じ）。

## 経緯【実測】

2026-10-03 にマージされた #1688〜#1694 を、いまの main で独立に確かめ直した。約束ごとに「足りない実装」と「やりすぎた実装」の変異を1つずつ入れ、名指しのテストファイルを走らせた。足りない側の変異はすべて赤になった。やりすぎ側で、次の4つがどの歯にも捕まらなかった。

| # | 元の PR・ADR | 約束 | すり抜けた変異 | 通った理由 |
|---|---|---|---|---|
| D2 | #1688（[ADR 0576](./0576-doc-code-drift-sweep-core-public-tsdoc.md)） | `RecallQuery.overFetchFactor` の TSDoc: `k' = max(1, round(limit × overFetchFactor))` | `recall-runtime.ts` の `Math.max(1, …)` を外す | `overFetchFactor` を渡すテストは、どれも `limit × overFetchFactor ≥ 1` だった。スキーマは `limit: 1, overFetchFactor: 0.1` を受けるので、下限が無いと k' が 0 になり何も取り込まない |
| D5 | #1688（ADR 0576） | `RecallQuery.text` の TSDoc: 空白だけの文字列は ZodError にならず、`stage_skipped`（`empty_query_content`）になる | スキーマの `text` を `z.string().trim().min(1)` にして断る | `empty_query_content` を見る歯は、どれも text を渡さない（`{}`）入力だった |
| E7・E8・G7 | #1692（ADR 0580） | `EventStore.get` は id の等しさで比べる（別のイベント id は `null`） | testkit `InMemoryEventStore.get`・core `FakeEventStore.get` の比較を `e.id.endsWith(lowered)`、または `lowered.startsWith(e.id)` にゆるめる | 歯が渡すのは「実在の id の末尾の1字を落とした id」だけだった |
| Z1 | #1694（[ADR 0582](./0582-adr-0573-teeth-holes-controls.md)） | `archiveDecayed`・`purgeMemory` が `updatedAt` を書くのは、対象の行だけ（Postgres の `UPDATE … WHERE m.id = t.id`・InMemory と同じ） | Fake が同じテナントの全部の行の `updatedAt` を書き換える | 歯は対象の行の `updatedAt` しか見ていなかった |

## 決定【判断】

1. 実装は変えない。4つとも実装は約束どおりで、歯が足りなかった。
2. 歯を足す（試験だけ）。
   - **D2**: `packages/core/src/__tests__/recall-pipeline.test.ts` に「k' は少なくとも 1」。埋め込み済みの記憶1件に `{ vector, limit: 1, overFetchFactor: 0.1 }` を当て、その1件が返ること。
   - **D5**: 同じファイルに「空白だけの text は ZodError にならず、`empty_query_content` で skip される」。記憶を1件置いたうえで `{ text: "   " }` を当て、`stage_skipped`（`candidate_generation`・`empty_query_content`）が `omitted` に在り、`memories` が空であること。
   - **E7・E8・G7**: `packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts` と `packages/core/src/__tests__/fake-uppercase-target-id.test.ts` の「別のイベント id は null」の歯に、先頭の1字を落とした id と、末尾に1字足した id を足す（どちらも `null`）。
   - **Z1**: `packages/core/src/__tests__/fake-event-time-nul-claim-controls.test.ts` の archive・purge の歯に、同じテナントの対照の行を1つずつ足す。archive では `decayFloorAt` が未来の行（archive されない）、purge では purge しない別の行。どちらも、呼んだ後の `updatedAt` が作成時のまま（archive の対照は `status` も active のまま、purge の対照は `purgedAt` が無いまま）であること。時計は既存の歯と同じく `vi.useFakeTimers({ toFake: ["Date"] })` で固定している。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。時刻を比べる歯（Z1）は、赤と緑を3回ずつ走らせた。

| 変異 | 赤 | 戻して |
|---|---|---|
| D2: `const kPrime = Math.round(limit * overFetchFactor)` | k' の歯（`expected [] to deeply equal [ 'mem-…' ]`） | `recall-pipeline.test.ts` 141本緑 |
| D5: `text: z.string().trim().min(1).optional()` | 空白だけの text の歯（`ZodError`） | 141本緑 |
| E7: testkit `e.id.endsWith(lowered)` | testkit の歯（`expected { id: 'evt-…' } to be null`） | 13本緑 |
| E8: testkit `lowered.startsWith(e.id)` | 同上 | 13本緑 |
| G7: core `e.id.endsWith(lowered)` | core の歯（同上） | 11本緑 |
| G8: core `lowered.startsWith(e.id)` | 同上 | 11本緑 |
| Z1: `archiveDecayed` が同じテナントの全部の行の `updatedAt` を書く | archive の歯（対照の行が `2030-01-02` になる。期待は作成時の `2030-01-01`）。3回とも赤 | 10本緑（3回とも） |
| Z1p: `purgeMemory` が同じテナントの全部の行の `updatedAt` を書く | purge の歯（同上）。3回とも赤 | 10本緑（3回とも） |

## 縛っていないもの

- **#1691（[ADR 0579](./0579-gate-red-tooth-names-one-db-test-file-instead-of-bail.md)）**: 門が引数を `test:db` へ渡さなくなっても、「門が赤くなる」歯は緑のまま（全ファイルを走らせても `FAIL contested-with-index` は出る）。捕まえるのは `MNEMORA_DB_TESTS_SKIP` の歯の 60 秒の期限切れだけで、引数の受け渡しを直接見る歯は無い。
- **#1693（[ADR 0581](./0581-adr-0572-index-underflow-getter-controls.md)）**: core の Fake の `setEventRetention` の中の int4 の上限の検査（`retention.days > 2 ** 31 - 1`）は、共有の `assertValidEventRetentionDays` が先に断るので届かない死んだコードになっている。害は無い。
- 確かめ直しで緑だったが穴ではないと見立てたもの: #1689 の「全部が再送でも壁時計を読む」（行を書かないので、どこにも差が出ない）。

## これが覆るとしたら

`RecallQuery.overFetchFactor` の下限、または空白だけの `text` の扱いを変えると決めたとき（そのとき TSDoc と D2・D5 の歯を一緒に直す）。`EventStore.get` が id の部分一致を許す契約に変わったとき。Postgres の `archiveDecayed`・`purgeMemory` が対象以外の行に書くようになったとき。
