# ADR 0599: core の Fake が別テナントの参照を断る検査に、message まで縛る歯を足す（#1549・#1543）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-587fc473）が書いた。message まで縛り、例外の型は縛らないと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0598](./0598-adr-0490-0480-0485-merged-pr-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯【現物】

core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）には、別テナントの行を指す参照を、実在しない id と同じ message で断る検査が2系統ある。どちらも、テナントの比較と message を縛る試験が無かった。

| Issue | ADR | 検査 |
|---|---|---|
| #1549 | [ADR 0439](./0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md) | `FakeMemoryStore` の書き込みの口で、参照先（memory・recall・observation）が `ctx` のテナントの行であること |
| #1543 | [ADR 0436](./0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md) | `FakeVectorStore.upsert` で、`memoryId` が `ctx` のテナントの記憶であること |

## 決定【判断】

1. 実装は変えない。
2. 歯を足す。新しいファイル `packages/core/src/__tests__/fake-cross-tenant-ref-message.test.ts`（DB 不要）。どの it も、別テナントの参照を断ることと、自テナントの参照が通ることを同じ検査の中で見る。
3. **message まで縛る**（クローンの判断）。`toThrow(文字列)` で `FakeMemoryStore: memory not found for tenant: <id>` などの部分一致を見る。**例外の型は縛らない**（`Error` の一種であればよい）。
4. 足した歯（it 名の頭の語は呼び出し名）:

| 参照の種類 | it | 口 |
|---|---|---|
| recall | `recordUsage: 別テナントの recallId …` | `recordUsage` の `recallId` |
| memory | `recordUsage: 別テナントの memoryIds …` | `recordUsage` の `memoryIds` |
| observation | `createMemory: 別テナントの sourceObservationId …` | `createMemory` |
| memory | `createMemory: 別テナントの contestedWithId …` | `createMemory` |
| memory | `createMemory: 別テナントの supersededById …` | `createMemory` |
| memory | `updateStatus: 別テナントの supersededById …` | `updateStatus` |
| memory（vector） | `FakeVectorStore.upsert: … 別テナントの memoryId …` | `FakeVectorStore.upsert` |

   `updateStatusWithEvent`・`resolveContested` 系の `supersededById` は、同じ `assertOwnMemoryRef` を通る【現物】ので、歯を置かない（主なものを選んでよい、というクローンの判断）。

## 変異試験【実測】

実装ファイル（`runtime-fakes.ts`）を `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。足す前の緑は7本。

| 歯 | 変異 | 赤（落ちた it） | 戻して |
|---|---|---|---|
| memory 参照（`assertOwnMemoryRef`） | 足りない側: テナントの比較を外す（存在だけ） | recordUsage の memoryIds・createMemory の contestedWithId・createMemory の supersededById・updateStatus の supersededById（4本） | cmp 一致・7本緑 |
| 同上 | やりすぎ側: 自テナントを断つ（`!==` を `===`） | recordUsage の recallId・memoryIds・contestedWithId・supersededById（create）・updateStatus（5本） | cmp 一致・7本緑 |
| 同上 | message から `for tenant` を落とす | memoryIds・contestedWithId・supersededById（create）・updateStatus（4本） | cmp 一致・7本緑 |
| recall 参照（`recordUsage`） | 足りない側: 比較を外す | recordUsage の recallId（1本） | cmp 一致・7本緑 |
| 同上 | やりすぎ側: 自テナントを断つ | recordUsage の recallId・memoryIds（2本。memoryIds の it は自テナントの recall が断たれて落ちる） | cmp 一致・7本緑 |
| 同上 | message から `for tenant` を落とす | recordUsage の recallId（1本） | cmp 一致・7本緑 |
| observation 参照（`createMemory`） | 足りない側: 比較を外す | createMemory の sourceObservationId（1本） | cmp 一致・7本緑 |
| 同上 | やりすぎ側: 自テナントを断つ | createMemory の sourceObservationId（1本） | cmp 一致・7本緑 |
| 同上 | message から `for tenant` を落とす | createMemory の sourceObservationId（1本） | cmp 一致・7本緑 |
| vector（`FakeVectorStore.upsert`） | 足りない側: 存在だけ見る | `FakeVectorStore.upsert` の it（1本） | cmp 一致・7本緑 |
| 同上 | やりすぎ側: 自テナントを断つ | 同上（1本） | cmp 一致・7本緑 |
| 同上 | message から `for tenant` を落とす | 同上（1本） | cmp 一致・7本緑 |

## 縛っていないもの

- 例外の型（クローンの判断）。
- `updateStatusWithEvent`・`resolveContested` 系の `supersededById`、`FakeEventStore.append` の `memoryId`（後者は [ADR 0469](./0469-fake-event-target-and-uuid-case.md) の範囲で、`fake-event-target-belongs-to-ctx-tenant.test.ts` が縛る）。

## これが覆るとしたら

Fake の message の形を変えると決めたとき（Postgres 実装・testkit の fixture の message との揃え方を含む）。そのときはこの歯の期待値を同時に直す。
