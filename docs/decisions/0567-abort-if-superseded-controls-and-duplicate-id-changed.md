# ADR 0567: ADR 0556 の歯が通した4つの変異を塞ぎ、`abortIfSuperseded` の綴り違いの同じ id を Postgres と同じ1件にし、0556 の「新しく断る入力は無い」を訂正する

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-d2a63d5d の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 経緯【実測】

[ADR 0556](./0556-fixtures-uppercase-abort-if-superseded-and-event-get.md)（PR #1667）の確かめ直しで、やりすぎた実装の変異のうち4つが、0556 の歯（testkit の `in-memory-uppercase-target-id.test.ts`・core の `fake-uppercase-target-id.test.ts`・postgres の `uppercase-target-id-parity.postgres.test.ts`）をすり抜けた。

| 変異 | 内容 | 0556 の歯をすり抜けた理由 |
|---|---|---|
| M2 | `assertNoneSuperseded` のテナントの検査を `(memory.tenantId === ctx.tenantId \|\| raw !== id)` に緩める | 別テナントの superseded な記憶を、大文字の id で渡す入力が無かった |
| M3 | `assertNoneSuperseded` のテナントの比較を `toLowerCase()` で畳む | ctx のテナントの綴りだけを変えて呼ぶ入力が無かった |
| M4 | testkit `InMemoryEventStore.get`・core `FakeEventStore.get` のテナントの比較を `toLowerCase()` で畳む | 同上（`EventStore.get` を、綴りの違うテナントで呼ぶ入力が無かった） |
| M5 | `memory.status === "superseded"` を `!== "active"` に広げる | superseded 以外の status（forgotten・contested・archived）を大文字の id で渡す入力が無かった |

別件として、`assertNoneSuperseded` に綴り違いの同じ id（`[x, X]`）を渡したときの `changed` を、読んだだけで走らせていなかった。

## 決定【判断】

1. 4つの変異を塞ぐ陽性対照を、`uppercase-target-id-parity.postgres.test.ts` に足す（3実装の突き合わせ。基準は Postgres の現物で、走らせて確かめた）。
2. `[x, X]` の件は食い違いが本物だったので、InMemory を Postgres に揃える（下）。
3. 0556 の CHANGELOG 節の訂正を、この ADR に書く（下）。0556 の本文は書き換えない。

## 足した歯【実測】

`packages/postgres/src/__tests__/uppercase-target-id-parity.postgres.test.ts`（Postgres を基準に、testkit と、`EventStore.get` は Fake も比べる。Fake は `abortIf*` を持たない: ADR 0493）:

| describe | it | 塞ぐ変異 |
|---|---|---|
| 別テナントの superseded な記憶は、大文字の id でも見ない | `createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories`（3本）。別テナントの superseded な記憶の id を、小文字・大文字で渡しても投げず、書く | M2 |
| ctx のテナントの綴りだけを変えて呼ぶ | `abortIfSuperseded` は、綴りの違うテナント（`TENANT-1`）の記憶を自分の記憶として見ない（同じ綴りなら断る、の陽性対照つき） | M3 |
| 同上 | `EventStore.get` は、綴りの違うテナントでは null（イベント id が大文字でも null）、同じ綴りなら当たる。pg・testkit・Fake の3実装 | M4 |
| superseded 以外の status は、大文字の id でも断らない | `active`・`forgotten`・`contested`・`archived`（4本。それぞれ3つの口 × 小文字・大文字。呼ぶ前に、記憶がその status であることも確かめる） | M5 |
| 綴り違いの同じ id を渡したとき、`changed` は Postgres と同じ | `[x, X]` は1件（3つの口で3本）。別々の3件は id の昇順（渡した順・綴りに依らない） | 下の F1・F2 |

`packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts` に、`[x, X]` の件と昇順の単体を1本足した（DB が無い環境でも走る）。

core の単体（`fake-uppercase-target-id.test.ts`）には足していない。M4 の Fake 側は突き合わせの歯だけが赤くなる（変異試験の表）。

## `[x, X]` の件【実測】

- **食い違いは本物だった。** `abortIfSuperseded` に `[src.id, 大文字の src.id]` を渡すと、Postgres の `changed` は**1件**（`SELECT id, status FROM memories WHERE tenant_id = ... AND id = ANY(...) ORDER BY id ASC` で行を選ぶので、1行につき1件・id の昇順）。InMemory は渡した id ごとに積んだので**2件**（同じ id が2回）だった。3つの口とも。
- 同じ原因で、**順序**も違った。Postgres は id の昇順、InMemory は渡した順。別々の3件を、昇順の逆に渡して比べると、`pg` は昇順、testkit は渡した順（歯だけを足した状態で赤）。
- **直し**（`packages/testkit/src/__fixtures__/in-memory-memory-store.ts` の `assertNoneSuperseded`）: 小文字にした id を `Set` で見て、2回目からは数えない。最後に `changed` を id の昇順に並べる。この fixture の id は小文字の `mem-N` で、Postgres の uuid（小文字の16進）と同じく、文字列の昇順で並べる。比べる id の形（`mem-N` と uuid）は違うので、**並びの具体的な順は同じにならない**（`mem-10` が `mem-9` の前に来る）。「昇順であること」だけが同じ。
- **直した後の緑**: 突き合わせ 72 本・testkit 12 本とも緑。

**直す前の赤**（歯だけを足した状態。Postgres の基準の assertion は緑）: `[x, X]` の3本が `2 ["<s0>(lower):superseded","<s0>(lower):superseded"]`（期待は 1 件）。昇順の1本が `3 sorted=false`。計4本赤（9本緑）。

## 0556 の「新しく断る入力は無い」の訂正【現物・判断】

[ADR 0556](./0556-fixtures-uppercase-abort-if-superseded-and-event-get.md) の「CHANGELOG」節は、`docs/migration-v1.md` に項目を足さない理由を「落ちる入力が減る側の変更で、新しく断る入力は無い」と書き、CHANGELOG の項目も「落ちる入力が減る側で、新しく断る入力は無い」と書いている。**これは正しくない。**

- 大文字の id を `abortIfSuperseded` に渡すと、以前の fixture は（superseded を見落として）**書いた**。いまは `SourceMemoryStatusChangedError` を**投げる**。`abortIfSuperseded` に大文字の superseded な id を渡して、書き込みが通ることに頼っていたテストは、いまは落ちる。**新しく断る入力は、ある**（Postgres に揃える向きの変更なので、Postgres が今断るものだけ）。
- `EventStore.get` のほうは、`null` が当たりに変わる側なので、断る入力は増えない（0556 の記述のとおり）。
- 本 ADR の `[x, X]` の直しも、`changed` の件数・並びを変える（同じ id が2回出ていたのが1回になる）。`changed` の件数や並びを読んでいたテストは、見直しの対象になる。

0556 の本文は書き換えない。訂正は、この節と、CHANGELOG・migration の項目に置く。

## migration に項目が要るか【判断】

**要る。`docs/migration-v1.md` の v1.3.0 の fixture の項目の並び（ADR 0558 の項目の直後）に、🟡 の項目を1つ足した。**

- 理由: 0556 の判断（「落ちる入力が減る側」なので不要）は、上の訂正のとおり前提が誤りだった。ADR 0558（自己置換の検査）が、同じ性格の変更（fixture が新しく断る入力が増える。Postgres が今断るものだけ）に、同じ並びへ項目を足している。それに倣う。ADR 0521 も項目を足している。
- 項目の書き方は周りに倣った（太字の見出しの1文 + 本文。🟡）。破壊的変更の番号付き（🔴）にはしない: fixture が新しく例外を投げる変更は破壊的と数えない（[ADR 0461](./0461-v1-2-0-release-prep-inspection.md)。ADR 0558 の項目と同じ引き方）。

## CHANGELOG【判断】

**書く**（`[1.3.0]` の `### Fixed`、ADR 0556 の項目の直後に1項目。0556 の項目は書き換えない）。

- 理由: 直したのは `@mnemora/testkit/fixtures` の `InMemoryMemoryStore`（公開物。`package.json` の `exports` に `./fixtures`）の振る舞いで、利用者に見える。ADR 0556 は testkit の fixture を直したとき、ADR 0558 も同じく、`[1.3.0]` の `### Fixed` に項目を足している。0556 の項目の「新しく断る入力は無い」の訂正も、この項目に置く。
- 歯だけの変更（parity・単体）は載せない（CHANGELOG の「何を載せるか」）。core の Fake は変えていない。

## 変異試験【実測】

足した歯ごとに、変異を1つ入れ、赤になる it を数えた。外す（`git checkout -- <ファイル>`、変異の前に commit 済み）と緑に戻る。歯は突き合わせ（Postgres・`DATABASE_URL` あり）72 本、testkit の単体 12 本、core の単体 10 本。

| 変異 | 赤（突き合わせ） | 赤（単体） | 外すと |
|---|---|---|---|
| M2: テナントの検査に `\|\| raw !== id` | 3 本（別テナント × 3つの口） | testkit 0 / 12 | 緑（72/72） |
| M3: `assertNoneSuperseded` のテナントを `toLowerCase()` で畳む | 1 本（ctx のテナントの綴り: `abortIfSuperseded`） | testkit 0 / 12 | 緑 |
| M4a: testkit `InMemoryEventStore.get` のテナントを畳む | 1 本（`EventStore.get` のテナントの綴り。`upper=found`） | testkit 0 / 12 | 緑 |
| M4b: core `FakeEventStore.get` のテナントを畳む | 1 本（同上。testkit は直したままなので、赤は Fake だけから） | core 0 / 10 | 緑 |
| M5: `status === "superseded"` を `!== "active"` に広げる | 3 本（`forgotten`・`contested`・`archived`。`active` は元から断らないので緑） | testkit 0 / 12 | 緑 |
| F1: `[x, X]` の直しのうち、重複を数えない処理を外す | 3 本（`[x, X]` × 3つの口） | testkit 1 / 12 | 緑 |
| F2: `[x, X]` の直しのうち、`changed` の昇順の並べ替えを外す | 1 本（昇順） | testkit 1 / 12 | 緑 |

M2・M3・M4・M5 は、0556 の歯（testkit・core の単体、突き合わせの既存 59 本）では緑のまま通った変異で、**足した歯だけが赤くする**。単体の「0 / 12」は、0556 の単体が通すことの再確認でもある。

## 直さないもの【判断】

- **Postgres の振る舞い**。
- **core の Fake の `abortIf*`**（ADR 0493 のとおり、持たない）。
- **`mem-N` と uuid の並びの違い**: 上のとおり、「昇順であること」だけを揃える。fixture の id の形を uuid にするのは、別の判断。

## 採らなかった案

- 歯を conformance suite に足す: ADR 0434 決定5のとおり、約束を足すのはオーナーの判断。
- `[x, X]` を直さず歯だけ残す: 食い違いが本物なので、約束（Postgres に揃える: ADR 0521・0556）どおりに実装を戻した。

## これが覆るとしたら

Postgres が `abortIfSuperseded` の `changed` の件数・並びを変えたとき（`ORDER BY id ASC` を外す、重複を数えるなど）。または fixture の id が uuid になったとき（並びの具体的な順まで比べられるようになる）。

## 【未確認】

- `[x, X]` 以外の、重複した id を渡す口（`getMany` など）の件数。ここでは比べていない。
- Fake の `memoryStore` に `abortIf*` が入ったときの綴り・件数（ADR 0493 が決めるまで比べない）。
