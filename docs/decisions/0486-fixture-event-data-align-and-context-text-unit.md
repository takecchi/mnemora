# ADR 0486: 穴探し53巡目の続き — testkit の fixture が関数・`Symbol`・`toJSON` を含む `event.data` を `DataCloneError` で断っていたのを Postgres に揃える。`extractionContext` の `text` の上限の単位を書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の承認を受けて、マネージャー mgr-3a4ae979 の指示で担い手が書いた。穴探し53巡目（PR #1590）の材料2・材料5を片付ける。#1590 は未マージなので、その ADR は番号でなく PR 番号で指す（この PR は #1590 の commit の上に積んでいる）。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22.23.3、zod 4.5.4、Postgres 17 + pgvector）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 材料2: fixture を Postgres に揃える

- **穴**【実測】（#1590）: `createObservation` / `createObservationWithOutbox` に、関数・`Symbol` を欄の値に持つ、または `toJSON` を持つ値を含む `payload`（`observe({ kind: "event", data })` の `data`）を渡すと、`@mnemora/postgres` は `JSON.stringify` の規則で保存して読み戻せるが、testkit の `InMemoryMemoryStore` だけが `structuredClone` の `DataCloneError` で断っていた。
- **決めたこと**【判断】: fixture を Postgres に揃える（落ちる入力が減る直し。ADR 0434・0466 と同じ種類）。`packages/testkit/src/__fixtures__/in-memory-memory-store.ts` の `createObservationIdempotent` が `payload` を保存する前に `toStorablePayload` を通す。
  - `toJSON` を持つ値 → `toJSON(欄の名前)` の戻り値に置き換える（戻り値にも同じ規則を当てる。`data` 自体が持てば object でない値になる）。**`Date` は例外で `toJSON` を呼ばず `Date` のまま保つ**（`ObserveEventInput.data` の TSDoc の表の既存の行を崩さないため）。
  - 関数・`Symbol` → 欄の値なら欄ごと消す、配列の要素なら `null`。
  - プレーンオブジェクトと配列だけ辿る。`Map`・`Set`・型付き配列・クラスのインスタンスは今までどおり `structuredClone` に任せる。`NaN`・`-0`・値が `undefined` の欄は触らない（表どおり fixture は保持する）。
  - 単純な `JSON.parse(JSON.stringify())` にしなかった理由: #1590 の変異Aのとおり、`NaN`・`-0`・`Date`・`undefined` の欄の行（表の「fixture はそのまま」）が壊れる。
- **変わった口**【現物】: `createObservationIdempotent` を通る口は `createObservation` と `createObservationWithOutbox` の2つだけ（`grep -n "createObservationIdempotent"`）。`payload` を書く他の口は fixture に無い（`getObservation` ほかは読むだけ）。core の `FakeMemoryStore` は #1590 の実測で既に Postgres と同じ側なので触っていない。
- **歯と赤→緑**【実測】: `packages/postgres/src/__tests__/observation-payload-json-roundtrip.postgres.test.ts` の、fixture が `DataCloneError` を投げると縛っていた2件を「どちらも Postgres と同じ値を返す」形に書き換え、配列の中・`toJSON` の欄の名前・戻り値の中の関数・`createObservationWithOutbox` の3件を足した（18件）。
  - 直す前の実装: 先に歯だけを commit し、3件が赤（`関数・Symbol`・`toJSON`・`createObservationWithOutbox`）。
  - 直した後: 18件緑。
  - 変異: 直しの呼び出しを外すと同じ3件が赤、`Date` を `toJSON` の対象に含めると `Date` の行が赤（1件）、戻すと18件緑。戻しは `cp` で行い、`git checkout` は使っていない。
- **残り**【未確認】: プレーンでないオブジェクト（クラスのインスタンス）の欄が関数を持つ場合は、Postgres が関数を落とすのに対し fixture は `structuredClone` が断る可能性がある。走らせて確かめていない。`Map`・`Set` の中の関数も同じ。
- **残りの材料（直していない）**: 材料1（空白だけの本文を拒むか）・3（`toJSON` を持つ `data` が object でない値で保存されること）・4（入れ子の深さの境目）は #1590 の ADR のとおりオーナーの領分で、この PR は触らない。
- **CHANGELOG**: `[1.2.0]` の `### Fixed` に1行。公開の fixture が断らなくなるだけで、`docs/migration-v1.md` の 🔴 は要らない。

## 材料5: `extractionContext.messages[].text` の `max(2000)` の単位

- **疑問**: #1590 の ADR は「zod の `max` は UTF-16 のコード単位で数えるはず」と書いたが、走らせていなかった（【未確認】と書いた）。
- **実測**【実測】（zod 4.5.4。`ExtractionContextSchema.safeParse({ messages: [{ text }] })`、探り棒は使い捨て）: 数える単位は **Unicode のコードポイント**。UTF-16 のコード単位ではない（#1590 の推測は外れていた）。書記素でもバイトでもない。

  | 入力 | コードポイント | コード単位 | 書記素 | 結果 |
  |---|---|---|---|---|
  | `a` ×2000 / ×2001 | 2000 / 2001 | 同じ | 同じ | 通る / 断る |
  | `😀` ×2000 / ×2001 | 2000 / 2001 | 4000 / 4002 | 同じ | 通る / 断る |
  | `😀` ×1001 | 1001 | 2002 | 1001 | **通る**（コード単位なら断られるはず） |
  | `e` + U+0301 ×1000 / ×1001 | 2000 / 2002 | 同じ | 1000 / 1001 | 通る / 断る |
  | `👨‍👩‍👧`（ZWJ、5コードポイント）×400 / ×401 | 2000 / 2005 | 3200 / 3208 | 400 / 401 | 通る / 断る |
  | 孤立サロゲート ×2000 / ×2001 | 2000 / 2001 | 同じ | 同じ | 通る / 断る |

  陽性対照: 同じ探り棒が、境目を挟んで「通る」と「断る」の両方を出した（`a`・`😀`・結合文字の各行）。`speaker` の `max(200)` も同じ単位（`😀` ×200 は通り ×201 は断る）。
- **決めたこと**【判断】: 挙動は変えず、`ExtractionContextSchema` の TSDoc に1文（「⚠ `messages[].text` の `max(2000)`（`speaker` の `max(200)` も同じ）が数える単位は Unicode のコードポイントである……」）を足した。記録の歯 `packages/core/src/__tests__/extraction-context-text-length-unit.test.ts`（6件）を足した。zod の版が変わって数え方が変わったとき、この歯が落ちる。
- **引き受けた負債**: この単位は zod の今の振る舞いであり、mnemora が約束した仕様ではない。`speaker` 以外の `min(1)`・`max` を持つ欄は、今回当てていない。

## これが覆るとしたら

fixture を Postgres に揃える方向は、`ObserveEventInput.data` を JSON の値に限る（入力を狭める）とオーナーが決めたとき、断る側に倒して置き換わる。
