# ADR 0506: core の Fake の残りの入力検査を InMemory・Postgres に揃える（`createRecall` の書けない値、`subjectId` を取る読み口、`ctx` の表）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（ADR 0220）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0437（負債）・0479・0480・0488 が「core のテスト用 Fake だけ検査が甘い」口を材料に残した。ADR 0493（#1603）が先に Fake の全メソッドへ `assertWellFormedCtx` を足したので、着手前に現物を読み、**残っているものだけ**を対象にした。

## 1. `ctx` の検査（ADR 0437 負債・0479・0488 の材料）【実測・現物】

結論: **`ctx` の検査は #1603 で既に全口に入っていた。この PR で足したのは、`ctx` の外側にある `subjectId` の口だけである。**

Fake（`packages/core/src/__tests__/runtime-fakes.ts`）と InMemory（`packages/testkit/src/__fixtures__/`）に、同じ `ctx`（空の `tenantId`・NUL・孤立サロゲート・`subjectId` の NUL・大文字・5000 字・絵文字・対のサロゲート）を Memory・Vector・Lexical・Event・Outbox・Relation の代表の口へ流し（使い捨ての probe。コミットしていない）、結果の種別を突き合わせた。

| 口 | NUL・孤立サロゲート（`tenantId`・`ctx.subjectId`） | 空・大文字・長い・絵文字・対のサロゲート |
|---|---|---|
| Memory・Vector・Lexical・Event・Outbox・Relation の各メソッド | Fake・InMemory とも `MalformedIdentifierError`（一致） | Fake・InMemory とも通る（一致） |
| Fake の `listJobs`・`setDefaultHalfLifeRecallsForTest`・`supportsAddOwnSubjectSeq`・`FakeEmbeddingProvider.embed` | 検査しない | port のメソッドではないテスト専用の口、または `ctx` を取らない口（【判断】対象外） |

**依頼文の「空の `tenantId` を受ける」は、断る側ではない**: InMemory も Fake も空の `tenantId` を通す。`packages/postgres/src` にも空の `tenantId` を断る検査は無い【現物】（実 DB で流して確かめてはいない【未確認】）。そのため「正当な ctx」の対照に空の `tenantId` を入れ、通ることを縛った。

## 2. 残っていた口（直した。Fake だけ）【実測】

InMemory が `MalformedIdentifierError`・`Error` で断り、Fake が通していた入力:

| # | 口 | 断るようにした入力（InMemory と同じ文面・同じ型） |
|---|---|---|
| R1 | `createRecall`（ADR 0480 の続き） | `subjectId`・`advanceActivityClock.subjectId` の NUL・孤立サロゲート（`MalformedIdentifierError`）。`query`・`budget`・`omitted`・`usage`・`indexBand`・`explain`・`returnedMemories` の NUL（キーも）、`NOT NULL` の `jsonb` 欄（`budget` 以外）が `undefined`・関数、`BigInt`・循環参照（`JSON.stringify` の `TypeError`）。何も書かず、活動時計も進めない。順は InMemory と同じ（ctx → 識別子 → `createdAt` → 書けない値） |
| R2 | `findActiveByClaimKey`・`findContestedByClaimKey`・`listActiveClaimPredicates` | `query.subjectId` の NUL・孤立サロゲート（読む前に断る） |
| R3 | `getSubjectActivitySeqs` | `subjectIds` の各要素の NUL・孤立サロゲート |

`createMemory`・`createMemoryWithOutbox`・`createObservation*`・`aggregateScope`・`supersedeWithNewMemories` の `subjectId` は、#1603 で入っていた（歯で確認）。Fake が実装していない `createMemoriesWithOutboxAndEvents` は対象外。

## 3. 決めたこと

1. R1〜R3 を Fake に足した（検査関数は testkit の `assertRecallRecordStorable` と同じ判定を Fake に写したもの。core から testkit は import できない〔`dependency-boundary`〕ので写した）。
2. 出荷物は変わらない（Fake はテスト専用、`packages/core/src/__tests__/` の下）。**CHANGELOG・`docs/migration-v1.md` は不要**【判断】。公開 API・既定値・conformance suite・InMemory・Postgres は変えていない。
3. 既存の core のテストが壊れた `ctx`・`subjectId` を使っていて赤になることはなかった（下の「走らせたテスト」）。意図的に壊れた ctx を使う既存の歯は見つからなかった。

## 4. 採らなかった案

- `listJobs`・`setDefaultHalfLifeRecallsForTest` にも `ctx` の検査を足す案: port のメソッドではなく、本物・InMemory に対応物が無い。揃える相手がいない。
- 空の `tenantId` を Fake で断る案: 本物が通すので、やりすぎになる。

## 5. 引き受けた負債

- 検査関数を testkit から Fake へ写したので、片方だけ直すと割れる。`fake-recall-and-subject-input-checks.test.ts` が Fake 側の約束を縛るだけで、InMemory との自動の突き合わせは無い（core が testkit を import できないため。ADR 0493 と同じ構造）。
- 空の `tenantId` を Postgres が通すことは、コードを読んだだけで実 DB では確かめていない。

## 6. これが覆るとしたら

- Postgres が空の `tenantId` を断ると分かったとき（InMemory・Fake も同時に直す。対照の歯の `""` を外す）。

## 7. 歯と測ったこと【実測】

- 歯: `packages/core/src/__tests__/fake-recall-and-subject-input-checks.test.ts`（28本）。断る側（R1〜R3、`ctx` の代表の口）と、やりすぎの対照（本物が通す ctx・`subjectId`・JSON 値）。
- 直す前: 28本中 24本が赤（4本は対照・順序に依らない口）。直した後: 28本緑。
- 変異（1つずつ前景で）: 足りない側 — `createRecall` の `subjectId` の識別子検査を外す（2本赤）・`advanceActivityClock.subjectId` を外す（2）・`assertFakeRecallRecordStorable` の呼び出しを外す（16）・NUL 検査を外す（8）・JSON の必須検査を外す（7）・`findActiveByClaimKey` の `subjectId` 検査を外す（2）・`getSubjectActivitySeqs` の検査を外す（2）・`get` の `ctx` 検査を外す（1）。やりすぎ側 — `budget` を必須にする（1）・`createRecall` で空・大文字・長い tenantId を断る（1）・非 ASCII の `subjectId` を断る（1）・`subjectIds` の非 ASCII を断る（2）・`get` で空の tenantId を断る（1）。全て赤、戻して緑。
- 走らせたテスト（名指し。core。全て緑）: 新規 + `createRecall`・`getSubjectActivitySeqs`・`findActiveByClaimKey` 等を参照する既存 23 本 + `recall-pipeline`・`fake-store-postgres-parity`・`fake-input-checks-round2`・`fake-read-and-claim-input-checks` + `fake-*` の残り・`runtime-fakes-filter-labels-subjectless`・`extract-redelivery-unsaveable-fake`（計 33 本）。`pnpm --filter @mnemora/core typecheck`・eslint・prettier（ts）は通した。
- 走らせていない: `runtime-fakes` を import する core のテスト約 150 本のうち上記以外（`createRuntime` 経由。Fake の変更は `createRecall`・claim key・活動カウンタの口に限られ、上の参照ファイルで覆われる）、他パッケージ、実 Postgres。
