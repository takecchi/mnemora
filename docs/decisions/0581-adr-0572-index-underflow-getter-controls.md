# ADR 0581: ADR 0572 の歯の穴（A4・B4・C6・B8）を塞ぐ——索引の巻き戻し・float4 アンダーフロー・読む側が行を作らない・setDecayClock の検査順

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-dcc786b9 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は走らせていないもの。

## 文脈【現物】

[ADR 0572](./0572-core-fake-supersede-atomic-controls.md)（PR #1684）は、[ADR 0564](./0564-core-fake-supersede-atomic-and-new-row-retention-default.md) の歯の穴 O1・O3・O5・O6 を塞ぐ歯を `packages/core/src/__tests__/fake-supersede-atomic-controls.test.ts` に足した。その ADR 0572 が約束した範囲を、core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）への変異で監査した。

ADR 0572 の約束（要点）:

- 失敗した `supersedeWithNewMemories` は、無関係な既存の状態を消さず（O1）、成功したときは冪等キーの索引を残す（O3）。
- 断られた書き込みは、新しいテナントの行を作らない（O5）。
- テスト専用の `setDefaultHalfLifeRecallsForTest` は行を作らない（O6）。

約30の変異を試し、大半は赤になった。生き残ったのは次の4つ（`runtime-fakes.ts` を戻して試した。Fake 自体は正しく、歯が足りなかった）。

| 変異 | 内容                                                                                                                         | 生き残った理由                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A4   | `supersedeWithNewMemories` の catch で `extractionIndex.clear()` した後、元の中身の書き戻しを落とす（やりすぎ）              | O1 の歯は先の記憶を `sourceObservationId` 無しで作るので、索引が空のまま。失敗後に索引が消えても気づかない |
| B4   | `setDefaultHalfLifeRecalls` の `rounded === 0`（float4 アンダーフロー）の分岐だけ、投げる前に `ensureRow` を呼ぶ（足りない） | O5 は上側の溢れ（`1e39`）しか試さない                                                                      |
| C6   | `getTaxonomyMode` が `ensureRow` を呼ぶ（読むだけで行ができる。やりすぎ）                                                    | 読む側が行を作らないことを縛る歯が、getter 全体には無かった                                                |
| B8   | `setDecayClock` が検査の前に Map へ書く（足りない）                                                                          | 不正な値を投げた後に `getDecayClock` で読み戻す歯が無い（行の有無だけを見ていた）                          |

C7（`getDefaultHalfLifeRecalls` が `ensureRow` を呼ぶ）は、O6 が `getDefaultHalfLifeRecalls` の後に `getEventRetention` を見るので偶然赤になる。C6 は同じ型なのに赤にならなかった。getter の歯は不揃いだった。

## 決定【判断】

1. 歯を `fake-supersede-atomic-controls.test.ts` に4本足す（11 本になる）。`runtime-fakes.ts` は変えない（このファイルに触れる別の PR が開いている）。
   - A4: `sourceObservationId`・`extractorVersion` 付きの記憶を `createMemoryWithOutbox` で作り、続けて news[1] が失敗する `supersedeWithNewMemories` を呼ぶ。索引は1件のまま残り、同じ入力を再送すると `created: false`（同じ id、`jobs` は空）。
   - B4: `setDefaultHalfLifeRecalls(ctxA, 1e-50)`（float4 で 0 に丸まる）は投げ、`getEventRetention` は `unset` のまま（`1e39` の歯と同じ観測）。
   - C6: 新しいテナントで、Fake の `TenantSettingsStore` の読む側（`getDefaultHalfLifeHours`・`getDecayClock`・`getDefaultHalfLifeRecalls`・`getActivitySeq`・`getSubjectActivitySeqs`・`hasSubjectActivityCounters`・`getTaxonomyMode`）を全部呼んだ後、`getEventRetention` が `unset`。観測の `getEventRetention` は読む側自身なので最後に置く。
   - B8: 不正な値の `setDecayClock` は投げ、その後の `getDecayClock` は呼ぶ前の値のまま。
2. B8 の約束の持ち主は ADR 0572 ではなく、書き込みの検査を決めた [ADR 0562](./0562-core-fake-isolates-caller-mutation.md)・[ADR 0563](./0563-core-fake-event-time-nul-and-claim-predicates.md) である。`setTaxonomyMode` は不正な値のあと `getTaxonomyMode` で読み戻して縛られていた（変異 B7 は赤になる）のに、`setDecayClock` は縛られていなかった。この ADR は「0562・0563 の約束の歯の厚さを揃えた」だけで、約束の中身は増やしていない。
3. C6 は、getter の歯の不揃い（C7 は偶然赤、C6 は生き残り）を、全部の getter を1本の歯でまとめて縛って解消する。ADR 0564 決定3（行を作らないのは書き込みの検査を通った後だけ）の読む側への当てはめで、InMemory・Postgres も読むだけでは行を作らない。

## 変異試験【実測】

`runtime-fakes.ts` を `cp` で退避し、変異を入れて該当の it だけ（`-t`）を走らせ、`cp` で戻して `cmp` が同一なのを確かめてから緑を確かめた。全体は走らせていない。

| 変異 | 赤の出力                                                           | 戻して    |
| ---- | ------------------------------------------------------------------ | --------- |
| A4   | `expected +0 to be 1`（索引が空）                                  | 緑（1/1） |
| B4   | `expected { kind: 'unlimited' } to deeply equal { kind: 'unset' }` | 緑（1/1） |
| C6   | 同上（`unlimited`。変異は `getTaxonomyMode` のみ）                 | 緑（1/1） |
| B8   | `expected 'bogus' to be 'wall'`                                    | 緑（1/1） |

## 直さないもの

- C8（`setDefaultHalfLifeRecallsForTest` が `decayClockByTenant` も書く）: 約束の外。ADR 0564 決定3が約束するのは「行を作らない」だけで、`ForTest` が他の Map に何を書くかは約束していない。歯にしない。

## CHANGELOG・migration を変えない理由

テストと文書だけで、出荷物は変わらない（ADR 0572・0574・0575・0580 と同じ）。

## これが覆るとしたら

`setDecayClock` と `setTaxonomyMode` の検査・書き込みの形を Fake で共通化し、1本の歯で両方が縛られるとき。`ForTest` の口が `decayClockByTenant` を書くことを約束に加えるとき（C8 が歯の対象になる）。
