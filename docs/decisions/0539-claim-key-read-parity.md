# ADR 0539: 穴探し — claim key と矛盾の検出の読み口（`findActiveByClaimKey`・`findContestedByClaimKey`・`listActiveClaimPredicates`）と、`observe` の `claimKey` 有効経路を3者（Fake・InMemory・Postgres）に流す歯（3者一致、割れは見つからなかった）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。[ADR 0536](./0536-parity-inventory-and-activity-clock.md) の棚卸しが挙げた「割れていそうな上位3つ」の**3つ目**（claim key・矛盾検出の読み口と、`observe` の `claimKey` 有効経路）に歯を足した。直す線（約束に実装を戻す、Fake・InMemory を Postgres に揃える）の中だけを直す方針だったが、**直す割れは見つからなかった**。実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0536 の表では、これらの読み口の「本体」の突き合わせは InMemory と Postgres の conformance だけで、Fake は単独の `claim-key-*.test.ts` が見ているだけだった（3者で揃えているのは `excludeMemoryId` の大文字だけ。`listActiveClaimPredicates` は `limit`・`subjectId` の境界だけ）。Fake の `findActiveByClaimKey`・`findContestedByClaimKey`（`runtime-fakes.ts`）は本体が重複した2つのコピーで、InMemory も同じ形、Postgres は SQL が別にある。したがって、鍵の等値・`subjectId` の NULL・有効期間の端・空の区間・`contentHash` の除外・述語の並びと重複の畳み方が、3者で同じかは、同じ入力を流して確かめていなかった。conformance・Fake 単独・Postgres 単独の既存の歯が見ている面は測り直さず、3者を並べたときの差だけを足した。

## 1. 測り方【実測】

1つの操作列（共有の `scenario`）を3者に流し、出力を平らなデータにして1つの `EXPECTED`（73 項目）に突き合わせた。`EXPECTED` は実 Postgres の出力から作り、Fake・InMemory が同じ出力を返すことを確かめた。Fake の側は `packages/core/src/__tests__/fake-claim-key-parity.test.ts`、InMemory と Postgres の側は `packages/postgres/src/__tests__/claim-key-parity.postgres.test.ts` で、操作列と `EXPECTED` は同じ文面を2つのファイルに持つ（ADR 0536・0538 と同じ形）。

契約【現物】（`MemoryStore.findActiveByClaimKey?` の TSDoc と ADR 0473）: 鍵（`subject`・`predicate`）は正規化済みの文字列として**そのまま等値比較**する（ストアは大文字小文字・空白・Unicode の正規化形を畳まない）、`subjectId` は NULL 同士も一致、`active`（contested の側は `contested`）の行だけ、`excludeMemoryId` と同じ `contentHash` の行は返さない、有効期間は半開区間 `[validFrom, validUntil)`（null は無限）の重なりで、空・逆転した区間は問い合わせ側も保存済みの行側も何とも重ならない、別テナントは見えない。`listActiveClaimPredicates` は `active` で述語が非 NULL の行を、述語ごとに新しい行で代表させ、新しい順（同着はコードポイント順）に `limit` 件。

操作列:
1. store の口: 1テナントに、同じ鍵 `("user", "address")` の記憶を、開区間・`[2020,2022)`・`[2022,2024)`（前者と接する）・空区間 `[2023,2023)`・逆転区間 `[2026,2025)` で作り、さらに鍵の主語だけ大文字（`"User"`）・主語の末尾に空白・述語の末尾に空白・述語だけ大文字・主語と述語の NFC と NFD・別述語・鍵なし・subject なし・別 subject・subject の NFC と NFD・`forgotten`・`archived`・`superseded`・別テナントの行を置く。`contested` は、開区間・`[2030,2032)`・空区間 `[2035,2035)`・逆転区間 `[2038,2037)` の4組（各2件）。
2. 問い合わせ（active と contested の両方に同じ問い合わせ）: 開区間、`[2021,2023)`、接する端（`[2022,null)`・`[null,2020)`・`[null,2030)`・`[2032,null)`）、空・逆転した問い合わせ区間、空・逆転した保存済みの行に当たる区間、subject の null・別・NFC・NFD、鍵の大文字・空白・NFC・NFD（主語と述語の両方）、別述語、`excludeMemoryId`（active のもの・contested のもの・別テナントの id）、同じ `contentHash`（active のもの・contested のもの）。別テナントからは自分の行だけが見えること。
3. `listActiveClaimPredicates`: 述語ごとの重複（新しい行が代表）・`forgotten` は数えない・subject（null 同士）・`limit` 1 と 0・別テナント・鍵なしの記憶。行は `sleep` で作成時刻を離して並べた。
4. `observe` に `claimKey: { enabled: true, detectContested: true }` を渡し、抽出と claim の導出の両方を返す LLM で、同じ鍵への到着を順に流す（`no_conflict`・`contested`・`contested_group`・`unresolved_conflict`、鍵の大文字小文字をランタイムが畳むこと、別 subject・subject なし・有効期間が接する／重なる到着）。到着ごとの検出結果、最終の `status`・正規化後の鍵・矛盾の相手を比べる。

## 2. 結果【実測。決定的】

- **3者が全 73 項目で一致した。** Fake・InMemory・Postgres で、store の口の戻り（記憶の別名の集合）・述語の一覧・`observe` の検出結果と最終状態が同じ。割れは見つからなかった。
- 決定的: 時刻は `sleep` で離した作成順だけに頼り（同着の並びは測っていない。§6）、有効期間・鍵・subject は固定値。id・score・実時間は比べる出力に入れていない。`EXPECTED` を埋めたファイル（Postgres 側は3回、最後の版で再度）を繰り返し走らせて同じ結果だった。
- 鍵の等値は3者とも**正確な文字列の一致**で、大文字小文字・末尾の空白・NFC と NFD を別の鍵として扱う（TSDoc のとおり）。これを歯にした。鍵の正規化の規則（どの文字列を同じとみなすか）は変えていない。

## 3. 決定したこと

1. 割れが無かったので、実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. 一致している今の振る舞いを歯で縛った（conformance suite には足さない。ADR 0434 決定5）:
   - `packages/core/src/__tests__/fake-claim-key-parity.test.ts`（Fake）
   - `packages/postgres/src/__tests__/claim-key-parity.postgres.test.ts`（InMemory と実 Postgres）
3. ADR 0536 の棚卸しの3つ目はこれで済み。残りの「次の候補」は、保持・掃除の口（ADR 0536 の2つ目）。

## 4. 変異試験【実測】

実装を1つずつ曲げて、歯が噛むかを確かめた。戻したあとは `git status` に歯の2ファイル以外が無いことを毎回確かめた。最終の版の歯に対して、異なる曲げ方の数は Fake 29・InMemory 26・Postgres 30（計 85）で、**すべて赤**になった。

- 区間の端（`<` を `<=` に）: 問い合わせの `from` と保存済みの `until`、保存済みの `from` と問い合わせの `until`。active と contested の両方（Postgres は SQL の2箇所 × 2口）。
- 空・逆転した区間を重なりに数える: 問い合わせ側と保存済みの行側。active と contested の両方。
- `status` の絞りを外す（Postgres は contested の口が active も含める）。
- `contentHash` の除外を外す、`excludeMemoryId` の除外を外す（active と contested。Postgres は JS 側の `filter`）、別テナントの絞りを外す。
- `subjectId` を NULL に緩く比べる（active と contested）。
- 鍵の比べ方を緩める: 主語の大文字小文字無視・NFC への正規化・trim、述語の大文字小文字無視・NFC への正規化・trim（Fake・InMemory・Postgres のそれぞれ）。
- `listActiveClaimPredicates`: 新しい順を古い順に、`status` の絞りを外す、`limit` を無視、`subjectId` の絞りを外す、別テナントの絞りを外す、重複の代表を最古の行にする（`MAX` を `MIN` に）。

**最初の版の歯で緑のまま通ったものと、そこから足した操作列**:
- 最初の版（55 項目）に対する Fake の変異で、4件が緑だった。(a) contested の口で、保存済みの `from` と問い合わせの `until` の端（`<` を `<=` に）。(b) contested の口で、保存済みの空・逆転した区間を重なりに数える。(c) contested の口で、`contentHash` の除外を外す。(d) active の口で、鍵の主語の大文字小文字を無視する（述語まで違う鍵しか置いておらず、主語だけが違う鍵が無かった）。足した操作列: 接する端の問い合わせ `[null,2030)`、空・逆転した contested の組（`[2035,2035)`・`[2038,2037)`）とそれに当たる問い合わせ、contested の行と同じ `contentHash` の問い合わせ、主語だけが大文字の鍵と問い合わせ。足したあとは4件とも赤。
- 次の版（InMemory・Postgres も含む）で、さらに2件が緑だった。(e) Postgres で、述語の末尾の空白を無視する変異（主語の側にしか空白の違いを置いていなかった）。足した操作列: 述語の末尾の空白・述語の大文字・述語の NFC と NFD の記憶と問い合わせ。足したあとは赤。(f) Fake と InMemory の「主語を NFC に正規化する」変異が緑だったのは、**変異の当て方の誤り**（述語の側に当てていた）で、歯の穴ではなかった。主語に当て直して赤。
- もう1件、Postgres で「重複の代表を最古の行にする」が緑だったのも、当て先が SQL ではなく同じ文言を持つ TSDoc の行だった**当て方の誤り**で、SQL に当て直して赤。

## 5. 検討した代替案

1. **store の口だけ流し、`observe` の経路は外す。** 採らなかった。ADR 0536 が3つ目に挙げたのは `observe` の `claimKey` 有効経路も含むので、store の戻りを Runtime がどう使って `contested` に落とすかまで同じ操作列で比べた。
2. **歯を足さず、結果だけ書く。** 採らなかった。

## 6. 測っていないこと

- **`listActiveClaimPredicates` の同着の並び（作成時刻が同じ行のコードポイント順）**: 作成時刻は各ストアが自分で打つので、3者で同じ同着を作れない。この面は `memory-store-conformance.ts` が（時刻を揃える手段で）縛っている。ここでは `sleep` で離した順だけを比べた。
- **`observe` の検出ロジック（core の Runtime）自体への変異**: 3者の違いではなく Runtime の1実装なので、変異試験は3つの store の読み口だけに当てた。Runtime の結果は3者で一致することだけを歯にした。
- **`limit` の不正値（負数・非整数・2^63 以上）**: 既存の単独の歯（`fake-list-claim-predicates-limit.test.ts` ほか）が縛っている。
- **claim key の導出（LLM が主語と述語を返す部分）・鍵の長さの上限（`claim-key-oversized-part.postgres.test.ts`）・索引の使われ方（`claim-key-index.postgres.test.ts`）・並行する書き込みとの競合**。
- 大量の行での挙動（`findActiveByClaimKey` に LIMIT が無いこと）。

## 7. オーナーの領分の材料

なし（割れも、既定値・公開 API・決定を覆す材料も、鍵の正規化の規則を決める必要も出なかった）。

## 8. これが覆るとしたら

- 鍵の等値の規則（ストアで正規化するか）や、有効期間の重なりの判定（半開区間、空・逆転した区間の扱い）を変えるとき（歯の `EXPECTED` を意図して書き換える）。
