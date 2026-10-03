# ADR 0563: core の Fake の `archived`・`purgedAt` の時刻、識別子と `lastError` の NUL、片側だけの claim key を、InMemory・Postgres に揃える

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-cb86a0fd の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 経緯と方針【現物】

core のテスト用 Fake（`packages/core/src/__tests__/runtime-fakes.ts`）は、testkit の適合テストを通っていない（Issue #768）。#768 のコメント2は、「Fake は適合テストに通さない・除外のオプションは足さない・直したものは専用の `fake-*.test.ts` で押さえる」と決めた。この ADR はその方針に乗る。

測り方は ADR 0562（PR #1675。並行で出ている。ADR のファイル名が定まっていないので、リンクは張らない）の手順と同じ（testkit に一時的な `tmp-fakes-conformance.test.ts` を作って `createFakeRuntimeStores()` の各 store を `describeMemoryStoreConformance`・`describeEventStoreConformance`・`describeOutboxStoreConformance` に渡し、終わったら消す。commit に入れない）。任意機能は、Fake が実装しているもの（`archiveDecayed`・`purgeMemory`・`listActiveClaimPredicates` など）だけを宣言した。

## 割れ【実測】

適合テストを流して赤になった 27 本のうち、この PR が直すのは次の 6 つ（テスト名で特定）。

| 適合テスト | Fake の割れ |
|---|---|
| `archiveDecayed が積む archived イベントの at は opts.now と同じ値になる（壁時計ではない）` | `archived` イベントの `at` を渡さず、`buildStoredEvent` が壁時計を入れていた。`InMemoryMemoryStore`・`@mnemora/postgres` は `opts.now` |
| `purgeMemory は event.at を渡すと、purgedAt にも同じ値を使う` | `purgedAt` は常に `new Date()`。`event.at` を無視していた |
| `NULを含む識別子は、書き込みも読み出しも断る` | `subjectId`・`externalId` の NUL を、`kind` を持たない素の `Error`（`assertObservationHasNoNul` など）で断っていた。孤立サロゲートは `MalformedIdentifierError` で断っていたが、NUL は先に走る素の `Error` の検査に取られていた |
| `fail は error の NUL を、6文字の \u0000 に置き換えて lastError に残す` | `lastError = error` のまま。NUL が残る（Postgres の `text` は保存できない） |
| `subject か predicate の片方しか無い claim key を持つ Memory は数えない（null を混ぜない）` | `listActiveClaimPredicates` が `claimKey` の有無だけで数え、`predicate` が無い行で並べ替えの `Buffer.from(undefined)` が `TypeError`。`subject` だけ無い行は `predicate` を数えに混ぜた |
| `purgeMemory は recalls.index_band の digestBand から、この memoryId の digest を伏せる` | **下の「digestBand の原因」。この PR では直さない** |

## digestBand の原因【実測・判断】

**時刻でも scrub の欠落でもない。Fake の `purgeMemory` は digestBand を正しく伏せている。** 赤は「他テナントの digestBand が変わっていない」を確かめる最後の期待値で出る（`expect(otherRecord.indexBand.digestBand).toEqual([{ memoryId, digest: memory.digest }])`）。

- 期待値の `memory.digest` の `memory` は、テストが `createMemory` から受け取った値である。Fake の `createMemory` はそれを **store の中の行そのもの**として返す（InMemory・Postgres は複製／読み戻した行を返す）。`purgeMemory` は同じ行の `digest` を `"[purged]"` に書き換えるので、`memory.digest` が purge のあとに `"[purged]"` へ変わり、期待値が割れる。実際の他テナントの値は元の文字列のまま、正しい。
- 確かめ方: 一時 wiring で `createMemory` の戻り値を `structuredClone` して返すと、同じ適合テストが緑になる（それ以外は変えていない）。
- ⟹ 原因は ADR 0562 の「呼び手の書き換え」の種類（返した値が store の中の行と繋がっている）に属する。**そちらで直る**ので、ここでは直さない。代わりに、Fake の伏せ方そのもの（同じテナントの該当 memoryId だけを `"[purged]"` にし、他の memoryId の `truncated` 付きの項目と他テナントの行は変えない）を、purge の前に digest の文字列を控えて比べる歯で縛った。この歯は直す前から緑である。

## 決定【判断】

1. `archiveDecayed` が積む `archived` イベントの `at` は `new Date(opts.now)`。
2. `purgeMemory` は `const at = event.at ?? new Date()` と1回だけ読み、`purgedAt` と積むイベントの `at`（`{ ...event, at }`）の両方に使う。省略時に壁時計を2回読むと `purgedAt` と `event.at` が割れた（歯の対照が見張る）。`event.at` を渡されない時まで要求することはしない。
3. 識別子（`subjectId`・`externalId`）は、素の `Error` の NUL の検査より**先に** `assertWellFormedIdentifier` を掛ける（`createObservationIdempotent`・`createMemory` の中。InMemory の公開メソッドと同じ順）。これで NUL も `MalformedIdentifierError`（`kind: "malformed_identifier"`、`reason: "nul"`、message に入力値を載せない）になる。識別子でない欄（`content`・`digest`・`tags`・`kind`・`payload` など）の NUL は、InMemory と同じく素の `Error` のまま。
4. `FakeOutboxStore.fail` は `error.replaceAll("\u0000", "\\u0000")` を `lastError` に残す（`InMemoryOutboxStore`・`PostgresOutboxStore` と同じ）。NUL 以外は変えない。
5. `listActiveClaimPredicates` は `claimKey.subject` と `claimKey.predicate` の**どちらも `null`/`undefined` でない**行だけを数える（InMemory は `== null` を飛ばし、Postgres は `IS NOT NULL` の両方）。空文字は `NULL` ではないので数える。
6. 既存の `fake-store-postgres-parity.test.ts` の3本（`subjectId`・`externalId` の NUL）は、期待する message を、旧い素の `Error`（`must not contain NUL`）から `MalformedIdentifierError`（`input.subjectId contains a NUL character`）に書き換えた。旧い文面は、まさにこの割れが生んだものだった。
7. **CHANGELOG と migration は変えない**（Fake は出荷物ではない）。

## 歯と実測【実測】

歯（3 ファイル + 既存 1 ファイルの期待値の更新）:

- `packages/core/src/__tests__/fake-event-time-from-opts.test.ts`（7 本）: `archived` の `at`（単発・複数件で壁時計が進んでも割れない）、掃かない行には積まない（対照）、`purgeMemory` の `event.at` を渡す／省略（壁時計を1回だけ読む・呼ぶ前と後の間）、digestBand の伏せ方（直す前から緑）。
- `packages/core/src/__tests__/fake-malformed-identifier-nul.test.ts`（26 本）: 6つの口（`createObservation`・`createObservationWithOutbox` の `subjectId`/`externalId`、`createMemory`・`createMemoryWithOutbox` の `subjectId`）を同じ4本に通す（`MalformedIdentifierError` の kind・reason・index・message／何も書かない／対照: NUL 以外の制御文字と対をなすサロゲートは通る／対照: 孤立サロゲートは引き続き `lone_surrogate`）。`fail` の NUL の置き換え、対照（NUL の無い error、NUL 以外の制御文字、文字どおりの `\u0000`、改行は変えない）。
- `packages/core/src/__tests__/fake-list-claim-predicates-partial-claim-key.test.ts`（6 本）: `subject` だけ・`predicate` だけ・両方空・片側が `null`、対照: 両方そろった claim key と空文字は数える、対照: claim key 無し・別 subject・active でない行は数えない。

直す前は 39 本のうち **15 本が赤、24 本が緑**。赤は `archived` の `at` 2、`purgedAt` 2（`event.at` を渡す1、省略時に壁時計を2回読む1）、識別子の NUL 6、`fail` 1、claim predicate 4。緑の24は対照と、digestBand の歯と、直す前から通っていた孤立サロゲートなど。直した後は 39 本とも緑。

変異試験（直した箇所を1つずつ誤りへ戻す・やりすぎにして、戻した後は緑）:

| 変異 | 赤になった it |
|---|---|
| `archived` の `at` を外す（壁時計に戻す） | 2（単発・複数件） |
| `purgedAt` を `new Date()` に戻す | 2（`event.at` を渡す・省略時の1回読み） |
| `purgedAt` は1回読みだが、イベントへ `at` を渡さない | 1（省略時の1回読み） |
| **やりすぎ**: `purgeMemory` が `event.at` を要求する（省略で断る） | 3（省略時の2本の対照 + digestBand の歯。後者は `event.at` を渡さない形だったため） |
| 観測の口で素の NUL の検査を先に戻す | 4（`createObservation`・`createObservationWithOutbox` の `subjectId`/`externalId`） |
| `createMemory` で素の `subjectId` の NUL の検査を先に戻す | 2（`createMemory`・`createMemoryWithOutbox`） |
| **やりすぎ**: 観測の口が NUL 以外の制御文字（U+0001〜U+001F）まで断る | 4（観測の4つの口の対照: NUL の無い識別子は通る） |
| `fail` の置き換えを外す | 1 |
| **やりすぎ**: `fail` が NUL 以外の制御文字まで `\uXXXX` に置き換える | 1（対照: NUL の無い error は変えない） |
| `listActiveClaimPredicates` の片側の除外を外す | 4（`subject` だけ・`predicate` だけ・両方 null・片側のみ） |
| **やりすぎ**: 空文字の `subject`/`predicate` まで飛ばす（`!x`） | 1（対照: 空文字も数える） |
| **やりすぎ**: 片側の claim key を別のキーとして数える（`predicate ?? subject`） | 4（`subject` だけ・`predicate` だけ・両方 null・片側のみ） |

既存の歯（前後比較）: `fake-*.test.ts` の全部と、`archiveDecayed`・`purgeMemory`・`listActiveClaimPredicates`・`outboxStore.fail`・`u0000`・`malformed`・`MalformedIdentifier`・`runtime-fakes` のどれかを含む core のテストファイル、合わせて 200 ファイル 2406 本を名指しで走らせた。直した後は **200 ファイル 2406 本が緑**。ただし、そのうち `fake-store-postgres-parity.test.ts` の3本は、上の決定6のとおり期待する message を書き換えるまで赤だった（旧い素の `Error` の文面を縛っていたため）。全テストは走らせていない。`pnpm typecheck`・`pnpm format:check` は通る。

直した後の適合テスト（一時 wiring）: 443 本のうち、この PR が対象にした 5 本は緑、digestBand の1本だけ赤（上のとおり ADR 0562 で直る）。

## 直さないもの【判断】

適合テストが赤のまま残る 22 本（直した後の再測定）のうち、この PR が扱わない分:

- **ADR 0562 の範囲（呼び手の書き換え、9本）**: `get`・`getMany`・`createMemory`・`supersedeWithNewMemories` の `created[].memory` が返す値、`append` の `meta`、`claimBatch` の `payload`、`complete`/`fail` の `opts.at`、と上の digestBand の1本。
- **意図して課していない 11本**: `status='contested'` を `contestedWithId` 無しで書く口の断り（`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`・`updateStatus`・`updateStatusWithEvent` の、断る本と、投げる例外の `method`/`memoryId` の本、計10本）と、`createMemory` の `halfLifeHours` の値域。core の既存テストが、この Fake に contested を直接書く前提で作られているため、揃えると各テストが縛るものが変わる。
- **ADR 0564 の範囲（原子性・保持期間の既定）**: `supersedeWithNewMemories` の `news[1]` の失敗でも何も残さない1本、`aggregateScope` の `scopeAggregate: 'skip'` の1本。
- **任意機能 4 本**: Fake が実装しない任意機能（`scrubPurged`・`createMemoriesWithOutboxAndEvents`・`supersedeCreatedEvents`・`abortIfForgotten`）は宣言していない。測っていない。

（分類は、赤の本数が 9 + 11 + 2 = 22 に合うことで確かめた。各本の原因を1本ずつ掘ったのは digestBand だけで、残りは名前とメッセージからの分類である。）

## 採らなかった案

- digestBand をこの PR の `purgeMemory` の中で直す（`createMemory` の戻り値を複製する）。複製は ADR 0562 が全部の口まとめて行う変更で、ここで一部だけ入れると 0562 と衝突する。
- 識別子の NUL を `assertObservationHasNoNul` の中で `MalformedIdentifierError` に変える。`kind`・`payload`・`attributes` は識別子ではなく、InMemory も素の `Error` で断る。識別子（`subjectId`・`externalId`）だけを先に掛けるほうが、InMemory の順とそのまま合う。

## これが覆るとしたら

#768 のコメント2の方針（Fake を適合テストに通さない）が変わるとき。そのときは、これらの歯は適合テストに置き換わる。
