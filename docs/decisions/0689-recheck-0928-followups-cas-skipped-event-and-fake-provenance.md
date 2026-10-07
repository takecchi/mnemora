# ADR 0689: 確かめ直し（Issue #1827）のあとの手当て——CAS に弾かれた対象のイベント・Fake の `stated`/`inferred`・`searchMany` の TSDoc・包みの `additionalProperties`

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827) の確かめ直し。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 経緯【実測】

確かめ直しで、実装と約束が外れている箇所が4つ見つかった。どれも Postgres は約束どおりで、外れていたのは testkit の fixture・core の Fake・TSDoc・歯の側である。

| # | 外れ | 約束の出所 |
| --- | --- | --- |
| ① | `supersedeWithNewMemories` の CAS に弾かれた対象に、書けないイベント（`kind=bogus`・`at=Invalid Date`・`actor` に NUL・`meta` に BigInt・`sizeBeforeBytes=1.5`）を渡すと、Postgres は ok（`conflicted=1`）を返し、fixture と Fake は5種類とも投げた | `MemoryStore.supersedeWithNewMemories` の TSDoc（CAS に弾かれた対象は例外にせず `conflicted` に積む）、ADR 0466・0469・0640 |
| ② | `stated`・`inferred` で `sourceObservationId` が `null` の Memory を、Postgres（DB の CHECK）と fixture は拒むが、core の Fake だけが受け付けた | `MemoryStore.createMemory` の TSDoc、`0001_init.sql` の CHECK |
| ③ | `payload: undefined` の Observation は Postgres だけが投げ、fixture は受け付ける | `MemoryStore.createObservation` の TSDoc が、この差そのものを約束している |
| #1312 | `VectorStore.searchMany?` の TSDoc が、「同じ key の前のクエリだけが投げる入力」の例に float4 の範囲を超える有限の値を挙げていた。ADR 0424 以降、そのクエリは比較不能として全 0 ベクトルに差し替わり、`search()` も `searchMany` も投げない | `VectorStore.search` の TSDoc、ADR 0424 |
| #1331 の確かめ直しで見つかった #1147 の約束 | `@mnemora/openai` が根の object でないスキーマを包むときの `additionalProperties: false` を落としても、どの歯も赤にならなかった（`openai` SDK の `toStrictJsonSchema` が欠けた値を補うため、SDK の検査に通す歯は見逃す） | PR #1147（OpenAI の strict は object すべてに `additionalProperties: false` を求める） |

## 決定【判断】

1. **①: fixture と Fake で、イベントの検査を CAS を通る対象だけに移す。** ADR 0640 が `at` の下限だけを `skipAtFloor` で分けたのを、イベントの検査全体に広げた（`skipAtFloor` は呼び手が無くなったので外した）。CAS を通る対象は、状態を書き換える前・news を作る前に投げる作法を崩さない。Postgres は変えない。fixture が投げる入力が減るだけの変更で、型は変わらない（オーナー回答 3f3411c5「fixture が新しく投げる変更は破壊的と数えない」より軽い向き）。CHANGELOG の Unreleased の Changed に1行足す。
2. **②: Fake も `stated`・`inferred` で列の `sourceObservationId` が `null` の Memory を拒む。** Fake は非公開で、受け付けていたのは「既存の試験のデータを書き換えたくない」ためだった。Postgres で書けない Memory を前提にした試験が Fake の上で緑になるほうが害が大きいので、揃える。落ちる既存の試験（31件・7ファイル）は、Observation を1件作って `sourceObservationId` に渡す形へ直した（`packages/core/src/__tests__/observed-memory.ts`）。由来の中身（`provenance`）・想起の振る舞いは変えていない。`fake-provenance-rejects.test.ts` の「受け付ける」6件は「拒む」へ書き換えた。
3. **③: 変えない。** TSDoc が差を約束しており、Postgres・fixture の今の振る舞いは `observation-event-input-current-behaviour.postgres.test.ts` が縛っている。fixture が `payload: undefined` を拒む変異を当てると、その歯が2本（`createObservation`・`createObservationWithOutbox`）赤になることを確かめた。Fake 側にはその差を縛る歯が無い（Fake が拒む変異は近くの歯のどれも赤にしなかった）が、約束は Postgres と fixture の差であって Fake は約束の外なので、歯は足さない。
4. **#1312: TSDoc の例を外し、いまの約束だけを書く。** クエリのベクトルの中身（`NaN`・`Infinity`・float4 に収まらない有限の値）では `search()` も `searchMany` も投げないので、同じ key の前のクエリだけが投げる入力は無い。過去のリリースの CHANGELOG の項目は当時の記録なので書き換えない。
5. **#1331（#1147 の約束）: 包みの根が `additionalProperties: false` を付けることに歯を足す。** 送る形そのものを見る（SDK の検査には頼らない）。`structured-root-wrapper-additional-properties.test.ts`。

## 歯【実測】

| 約束 | 歯 | 変異（元の実装へ戻す） |
| --- | --- | --- |
| ① fixture | `packages/testkit/src/__tests__/in-memory-fixtures-supersede-cas-skipped-event.test.ts` | イベントの検査を全対象へ戻す → 6本が赤 |
| ① Fake | `packages/core/src/__tests__/fake-supersede-cas-skipped-event.test.ts` | 同上 → 6本が赤 |
| ② Fake | `packages/core/src/__tests__/fake-stated-inferred-requires-source-observation.test.ts`、`fake-provenance-rejects.test.ts` | 拒否を外す → 3本・6本が赤 |
| #1331 | `packages/openai/src/__tests__/structured-root-wrapper-additional-properties.test.ts` | 包みから `additionalProperties: false` を落とす → 4本が赤（既存の openai の試験10ファイルは、この変異で赤にならない） |

各変異は `cp` で控えを取り、当てて、戻して `cmp` が一致することを確かめた。

## 採らなかった案

- ②で Fake の拒否を見送り、既存の試験のデータを書き換えない案: Fake が Postgres より緩いままで、Postgres で書けない Memory を前提にした試験が通り続ける。
- ③で fixture か Fake を Postgres に揃える案: TSDoc が差を約束しているので、揃えるなら約束の変更になる。オーナーの判断が要る。

## 確かめていないこと

- ①の Postgres と fixture を実 DB で並べる歯（`packages/postgres`）は足していない。この PR では、使い捨ての試験で5種類すべてが Postgres・fixture とも `conflicted=1` を返すことを実測しただけである（コミットしていない）。
- ②の Postgres 側（DB の CHECK）は、この PR では当て直していない（`0001_init.sql` と TSDoc を読んだだけ）。
