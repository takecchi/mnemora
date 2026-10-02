# ADR 0572: ADR 0564 の歯の穴（O1・O3・O5・O6）を塞ぎ、ADR 0563 の範囲の記述を訂正する

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-f9bd8ced の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は走らせていないもの。

## 文脈【現物】

[ADR 0564](./0564-core-fake-supersede-atomic-and-new-row-retention-default.md)（PR #1674）は、core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）の `supersedeWithNewMemories` を原子的にし、新しいテナント行の保持期間の既定を揃えた。独立検証で、次の4つの変異が生き残った（既存の歯が赤にならない）。

| 変異 | 内容                                                                           | 既存の歯で赤にならなかった理由                                                                                                 |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| O1   | `supersedeWithNewMemories` の catch に `this.backing.events.length = 0` を足す | `snapshotOf` は events を含むが、どの歯も失敗の前にイベントを作っていない                                                      |
| O3   | 成功したときにも `extractionIndex` を巻き戻す                                  | 成功した後に同じ入力を再送する歯が無い                                                                                         |
| O5   | `setTaxonomyMode`（ほか）で `ensureRow` を検査の前に移す                       | 断られた書き込みのあと `getEventRetention` を見る歯が、`setDefaultHalfLifeRecalls` と `setDecayClock` のうち一部にしか無かった |
| O6   | テスト専用の `setDefaultHalfLifeRecallsForTest` に `ensureRow` を足す          | ADR 0564 決定3「`ForTest` は変えていない」を縛る歯が無い                                                                       |

## 決定【判断】

1. 歯を新しいファイル `packages/core/src/__tests__/fake-supersede-atomic-controls.test.ts`（7 本）に足す。ADR 0564 の既存の歯のファイルは触らない。
   - O1: 先に別の記憶を superseded にしてイベントを1件残し、そのあと news[1] が失敗する呼び出しで、イベントが1件残り、裏の状態が前後で一致する。
   - O3: `sourceObservationId`・`extractorVersion` を付けた news で `supersedeWithNewMemories` を成功させ、同じ入力の `createMemoryWithOutbox` を再送すると `created: false`（同じ id、`jobs` は空）。
   - O5: `setTaxonomyMode(ctxA, "bogus")`・`setDefaultHalfLifeRecalls(ctxA, 1e39)`（float4 に収まらない）・`setDecayClock(ctxA, "bogus")` は投げ、`getEventRetention` は `unset` のまま。対照として、検査を通った `setTaxonomyMode` は `unlimited`。
   - O6: `setDefaultHalfLifeRecallsForTest` のあとも `getDefaultHalfLifeRecalls` は値を返し、`getEventRetention` は `unset`。
2. `runtime-fakes.ts` は変えない。4つとも Fake のバグではなく、歯が無かっただけだった（元のコードは InMemory・Postgres と一致する）。
3. 期待値の根拠: `InMemoryTenantSettingsStore.setTaxonomyMode` は `assertValidTaxonomyMode` のあとに `ensureRow`、`PostgresTenantSettingsStore.setTaxonomyMode` も検査のあとに upsert【現物】。InMemory には `setDefaultHalfLifeRecallsForTest` に相当する口が無い（本番メソッドとの名前衝突で削除済み、`runtime-fakes.ts` の doc コメント）ので、O6 は Fake 固有の取り決め（ADR 0564 決定3）を縛るだけで、InMemory・Postgres との食い違いではない。
4. O6 の前提の確認【実測】: `setDefaultHalfLifeRecallsForTest` を `grep -rn` で repo 全体（`node_modules`・`.git` を除く）から探すと、コードでの出現は `runtime-fakes.ts` の定義1か所だけで、core のどのテストも呼んでいない。つまり「行を作らない」にも「作る」にも、既存のテストは頼っていない。文書での出現は ADR 0506・0197・0564。

## ADR 0563 の記述の訂正【現物】

[ADR 0563](./0563-core-fake-event-time-nul-and-claim-predicates.md) の「直さないもの」節（83行目）は、ADR 0564 の範囲を「`supersedeWithNewMemories` の `news[1]` の失敗でも何も残さない1本、`aggregateScope` の `scopeAggregate: 'skip'` の1本」と書いている。ADR 0564 自身の表（「割れは2つ」）では、割れは `supersedeWithNewMemories` の1本と「行が無いテナントに `setDefaultHalfLifeRecalls` すると行ができる」の1本で、`aggregateScope` は ADR 0564 に出てこない。`aggregateScope` の `scopeAggregate: 'skip'` の歯は testkit の conformance に在る（`memory-store-conformance.ts`）が、ADR 0564 が直したものではない。

正しい範囲は「`supersedeWithNewMemories` の原子性1本と、行が無いテナントの `setDefaultHalfLifeRecalls` の1本」。ADR 0563 は書き換えない（採用済みの記録を後から直さない）。この節が訂正である。`aggregateScope` の `scopeAggregate: 'skip'` の1本が、ADR 0562・0563・0564 のどれの範囲か、あるいは「意図して課していない」側かは、この ADR では調べていない【未確認】。

## 変異試験【実測】

新しい歯を WIP として commit したあと、`runtime-fakes.ts` を `cp` で退避し、変異を1つずつ入れて新しいファイルだけを走らせ、`cp` で戻して緑に戻ることを確かめた（戻した後の `git status --short` と `git diff` は空）。

| 変異                                                              | 赤の本数（7 本中） | 赤になった it     | 戻して緑 |
| ----------------------------------------------------------------- | ------------------ | ----------------- | -------- |
| O1: catch で `events.length = 0`                                  | 1                  | O1                | 7/7      |
| O3: 成功後に `extractionIndex` を巻き戻す                         | 1                  | O3                | 7/7      |
| O5a: `setTaxonomyMode` の `ensureRow` を検査の前へ                | 1                  | O5（不正な mode） | 7/7      |
| O5b: `setDefaultHalfLifeRecalls` の float4 検査の前に `ensureRow` | 1                  | O5（float4）      | 7/7      |
| O6: `setDefaultHalfLifeRecallsForTest` に `ensureRow`             | 1                  | O6                | 7/7      |

O5 で `setDecayClock` の検査の前に `ensureRow` を移した変異は試していない【未確認】（その歯は入れたが、赤になることは測っていない）。

## 走らせたもの【実測】

新しいファイルを名指しで走らせた（7 本緑）。全テストは走らせていない（CI が走らせる）。Postgres は要らないので立てていない。

## CHANGELOG・migration を変えない理由

テストと文書だけで、出荷物は変わらない。

## これが覆るとしたら

`supersedeWithNewMemories` の news の検査を書き込みの前に分ける作りに `createMemoryIdempotent` を割くとき（O1・O3 の歯が見る巻き戻しが要らなくなる）。`setDefaultHalfLifeRecallsForTest` を本番の口と同じ意味にする決定をしたとき（O6 の歯を消す）。
