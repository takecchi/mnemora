# ADR 0564: core の Fake の `supersedeWithNewMemories` を原子的にし、新しいテナント行の保持期間の既定を Postgres に揃える

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-cb86a0fd の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は走らせていない・数え直していないもの。

## 文脈【現物】

- Issue #768 のコメント2（クローン miku が決めた）の方針に乗る: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）は testkit の conformance に通さない。除外オプションは足さない。直したものは専用の `fake-*.test.ts` で押さえる。
- 測り方は ADR 0562（PR #1675）の手順と同じ: testkit に一時的なテスト `packages/testkit/src/__tests__/tmp-fakes-conformance.test.ts` を作り、`createFakeRuntimeStores()` の store を `describeMemoryStoreConformance`・`describeTenantSettingsStoreConformance` に渡して名指しで走らせ、終わったら削除した（commit に入れていない）。配線は `in-memory-fixtures.conformance.test.ts` に倣った。任意機能は宣言しないが、対象の it が `supportsSupersedeWithNewMemories` の中にあるので、それだけ `true` にした。`setDefaultHalfLifeHours` は Fake に書き口が無いので渡していない。
- 割れは2つ（他の種類は ADR 0562・0563 が直す）。

| conformance の it | Fake（直す前） | InMemory・Postgres |
|---|---|---|
| `supersedeWithNewMemories は news[1] の sourceObservationId が実在しないと投げ…何も残さない` | 投げるが news[0] の記憶が残る | 何も残さない |
| `行が無いテナントに setDefaultHalfLifeRecalls すると行ができる` | 保持期間は `unset` のまま | `unlimited` |

## 決定【判断】

1. `supersedeWithNewMemories` は、news の作成が途中で投げたら、それまでに作った分（記憶・冪等キーの索引・ラベルと記憶の紐付け・outbox の行）を巻き戻して投げ直す。InMemory は書き込みの前に検査を全部済ませるが、この Fake は検査と書き込みが `createMemoryIdempotent` に同居している（`createMemoryWithOutbox` など他の口と共有）。そこを割ると他の口の検査の位置まで動くので、巻き戻しにした。巻き戻すのは news の作成が触る 4 つの Map と outbox だけ。supersede 側の書き込みは news の後ろにあり、投げない。
2. `FakeTenantSettingsStore` に `ensureRow` を置き、`setDefaultHalfLifeRecalls`・`setDecayClock`・`setTaxonomyMode` が、検査を通ったあと書く直前に呼ぶ。保持期間のキーが無ければ `null`（`unlimited`）を立てる。既にキー（`days`・`unlimited`）があれば変えない。Postgres の upsert と、InMemory の `ensureRow` と同じ。conformance で赤になったのは `setDefaultHalfLifeRecalls` だけだが、Postgres では 3 つとも同じ upsert なので揃えた。
3. テスト専用の `setDefaultHalfLifeRecallsForTest` は変えていない（本番の口ではなく、既存テストが使う）。

## 既定値の変更で core の既存テストを当てた【実測】

Fake の既定を変えると `unset` に頼るテストが赤になりうるので、直す前に洗った。`unset`・`eventRetention`・`getEventRetention`・`FakeTenantSettingsStore`・`tenantSettingsStore`・`setDecayClock`・`setTaxonomyMode`・`setDefaultHalfLifeRecalls` のどれかを含む `packages/core/src` の `*.test.ts` を grep で集め（150 ファイル）、直したあとの Fake に名指しで流した: 150 ファイル・2022 本すべて緑。頼っているテストは無かった。

`unset` を直接期待する次のテストは、どれもその前に上の 3 つの口を呼ばない（保持期間を一度も書いていないテナント）ので影響を受けない。
`fake-retention-purge-parity`・`fake-tenant-settings-event-retention-per-tenant`・`event-retention-purge`・`erase-tenant`・`fake-tenant-settings-write-validation`。

## 歯と赤の記録【実測】

- `packages/core/src/__tests__/fake-memory-store-supersede-atomic.test.ts`（4 本）: news[1] が実在しない観測を指すと投げ、裏の状態（記憶・索引・ラベル・イベント・outbox）が呼ぶ前と一致する。失敗後に news[0] を同じ入力で作り直すと `created: true`。無関係な既存の記憶・ラベル・outbox は残る。対照として、全部の news が正しければ全部書かれて旧行が superseded になる。
- `packages/core/src/__tests__/fake-tenant-settings-new-row-retention-default.test.ts`（7 本）: 3 つの口それぞれで `unset` → `unlimited`。対照として、既に `days` のテナントは 3 つを書いても変わらない・書いたのは別のテナントなら行の無いテナントは `unset`・何も書かない／断られた書き込みでは `unset`・`unlimited` のあとに `setEventRetention(days)` で `days` になる。
- 直す前の赤: 11 本中 6 本が赤（atomic 3 本、retention 3 本）、5 本（対照）が緑。直した後は 11 本とも緑。
- conformance（一時テスト）でも、直す前は 2 本とも赤（`expected [ { id: 'mem-3', … } ] to deeply equal []` と `expected { kind: 'unset' } to deeply equal { kind: 'unlimited' }`）、直した後は 2 本とも緑。

## 変異試験【実測】

直しを外す変異と、やりすぎの変異を 1 つずつ入れて、新しい歯だけを走らせた（戻した後は `git diff` が空で、11 本緑）。

| 変異 | 赤になった it |
|---|---|
| 巻き戻し全体を外す（catch で投げ直すだけ） | atomic の 3 本（作り直し・無関係な行・全体の状態） |
| outbox の巻き戻しだけ外す | 2（全体の状態、無関係な行） |
| ラベルの巻き戻しだけ外す | 2（同上） |
| 冪等キーの索引の巻き戻しだけ外す | 1（全体の状態） |
| 記憶の Map の巻き戻しだけ外す | 2（同上） |
| やりすぎ: 失敗時に outbox を全部消す（無関係な既存行まで） | 1（無関係な行は残る） |
| やりすぎ: 成功しても outbox を巻き戻す（正しい入力でも書かない） | 1（対照: 全部正しければ全部書かれる） |
| やりすぎ: 成功しても labels を巻き戻す | 1（同上） |
| `ensureRow` を空にする | 3（3 つの口） |
| やりすぎ: `ensureRow` が既存の保持期間も `unlimited` に上書き | 1（既に `days` のテナントは変わらない） |
| やりすぎ: `ensureRow` が別のテナントの行も作る | 1（書いたのは別のテナント） |
| やりすぎ: 検査の前に `ensureRow`（断られた書き込みも行を作る） | 1（断られた書き込みは行を作らない） |

冪等キーの索引だけを外した変異は、作り直しの歯では赤にならない（記憶の Map も巻き戻されるので、索引が残っても作り直しが新規になる）。全体の状態の歯が捕まえる。

## 走らせたテスト【実測】

名指しで 153 ファイル・2037 本、すべて緑（上の grep の集合に、新しい 2 ファイルと `fake-memory-store-supersede-with-new-memories`・`fake-store-postgres-parity` を足したもの）。全テストは走らせていない（CI が全部を走らせる）。`pnpm typecheck`・`pnpm format:check` も通った。Postgres を要る歯は手元で走らせていない【未確認】。

## 直さないもの

- Fake に意図して課していない制約（マネージャーの指示では 11 本）と、Fake が実装しない任意機能（同 4 本）。Issue #768 のコメント2のとおり、conformance に通さず、除外オプションも足さない。本数は指示の数で、この ADR では数え直していない【未確認】。
- ADR 0562（呼び手の書き換えからの隔離）と ADR 0563（時刻・NUL・claim predicate）が直すもの。
- InMemory 側の `supersedeWithNewMemories` と Postgres。変えていない。

## CHANGELOG・migration を変えない理由

CHANGELOG と migration は変えない（Fake は出荷物ではない）。

## これが覆るとしたら

`supersedeWithNewMemories` の news の検査を書き込みの前に分ける作りに `createMemoryIdempotent` を割くとき（巻き戻しが要らなくなる）。または Postgres の `tenant_settings` の行ができる条件（どの設定を書いても upsert）が変わるとき。
