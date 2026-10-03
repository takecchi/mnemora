# ADR 0595: 10/02 にマージされた #1666〜#1680 の確かめ直しで見つかった穴を塞ぐ（ADR 0562 の写しの5欄・ADR 0557 の group の大文字の輪）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）が書いた。歯を書くと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) などの試験だけの PR と同じ）。

## 経緯【実測】

2026-10-02（UTC）にマージされ、Fake・testkit の fixture を変えた7本（#1675・#1680・#1676・#1674・#1669・#1668・#1666）を、いまの main で独立に確かめ直した。7本とも先に別の担当が確かめ直していたので、それらの ADR が当てた変異は繰り返さず、残りの約束に「足りない実装」「やりすぎた実装」の変異を当てた。すり抜けたのは次のとおり。

| PR・ADR | 約束 | すり抜けた変異 | 通った理由 |
|---|---|---|---|
| #1675（[ADR 0562](./0562-core-fake-isolates-caller-mutation.md)） | 決定2: 入力は保存するときに写す（`createMemoryIdempotent` の Date の列、`buildStoredEvent` の `at`・`actor`） | `decayFloorAt`・`occurredAt`・`validUntil`（記憶）と `at`・`actor`（イベント）を、写さずに保存する（P2〜P6。1つずつ） | 入力を後から書き換える歯は `tags`・`attributes`・`validFrom`・`provenance`・`recordedAt`・`meta` の分しか無かった |
| #1668（[ADR 0557](./0557-core-fake-superseded-by-checks.md)） | 決定4: 自己置換と循環は、両側を `normId` で畳んで比べる | 循環の検査（`assertFakeNoSupersededCycle`）の中で `supersededById` を畳まない（T3） | 下の「T3 の見立ての訂正」 |

### T3 の見立ての訂正【現物・実測】

確かめ直しの報告では、T3 を「大文字の輪を見落とす穴」とした。**これは誤りだった。** `resolveContestedPair`・`resolveContestedGroup` は、循環の検査の前に `normPairSide` で `supersededById` を畳んでいる（`runtime-fakes.ts`）。循環の検査の関数の中の畳みは冗長で、T3 だけを入れても約束の上の振る舞いは変わらない（同値の変異。[ADR 0558](./0558-inmemory-self-supersede-check-folds-both-sides.md) の「片側だけ畳む」と同じ形）。group の上流の `normPairSide` だけを外す変異（T5）も、同じ理由で単独では変わらない。

ただし、pair の循環の歯には大文字の輪の入力があるのに、group の循環の歯には無かった。どこでも畳まない実装（T3 と T5 を両方入れた形）では、group の大文字の輪を断らずに書く。決定4の約束を口ごとに縛るため、group にも大文字の輪の入力を足す【判断】。

## 決定【判断】

1. 実装は変えない。
2. 歯を足す（試験だけ。どちらも `packages/core/src/__tests__/`）。
   - **ADR 0562**: `fake-isolates-caller-mutation.test.ts` に2本。
     - 「`createMemory`: 入力の `decayFloorAt`・`occurredAt`・`validUntil` も保存時に切り離される」。渡した後に3つの Date を `setTime(0)` で書き換え、`get` で読んだ値が渡したときの値のまま。
     - 「`append`: 入力の `at`・`actor` を後から書き換えても、保存した値は変わらない」。`at` を `setTime(0)`、`actor.type` を書き換え、`EventStore.get` で読んだ値が渡したときの値のまま。
     - 既存の歯「入力の tags・attributes・validFrom…」「入力の provenance・recordedAt…」「append: 入力 meta…」と同じ形。
   - **ADR 0557**: `fake-superseded-by-checks.test.ts` の group の「メンバー同士で輪になる」歯に、`supersededById` を大文字にした輪（`[active, → MS2(大文字), → ms1]`）を足し、同じ `RangeError`（`resolveContestedGroup: supersededById must not form a cycle among the members`）になること。

## 変異試験【実測】

`runtime-fakes.ts` を `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。

| 変異 | 赤 | 戻して |
|---|---|---|
| P2: `decayFloorAt: input.decayFloorAt` | 3つの Date の歯（`expected '1970-…' to be '2026-06-01…'`） | 26本緑 |
| P3: `occurredAt: input.occurredAt ?? null` | 同上（`'2026-01-01…'`） | 26本緑 |
| P4: `validUntil: input.validUntil ?? null` | 同上（`'2027-01-01…'`） | 26本緑 |
| P5: `actor: event.actor` | `at`・`actor` の歯（`expected { type: 'mutated-by-caller' } to deeply equal { type: 'system' }`） | 26本緑 |
| P6: `at: event.at ?? new Date()` | 同上（`expected '1970-…' to be '2026-01-01…'`） | 26本緑 |
| T3 だけ（循環の検査の中で畳まない） | 緑のまま（同値。上の訂正） | — |
| T3 + T5（group の上流の `normPairSide` も外し、どこでも畳まない） | group の輪の歯（`expected undefined to be an instance of RangeError`。断らずに書いた） | 20本緑 |

## 縛っていないもの

- T5 の形（group が `supersededById` を畳まずに受ける）で、保存される `supersededById` の大文字小文字がどうなるかは、見ていない。今の実装は上流で畳むので、保存されるのは小文字。
- 確かめ直しで当てなかった変異（`\u` の表記を含む行・同値の変異・約束の上で差が出ない変異）は、確かめ直しの報告に理由を書いた。

## これが覆るとしたら

Fake が入力の写しを取る範囲を変えるとき（ADR 0562 決定2）。`resolveContestedGroup`・`resolveContestedPair` の上流の畳みを外すとき（このとき循環の検査の中の畳みが唯一の守りになり、この歯がそれを縛る）。
