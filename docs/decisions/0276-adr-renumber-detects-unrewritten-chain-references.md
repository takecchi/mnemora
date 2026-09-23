# ADR 0276: `adr-renumber.mjs` は、`ADR NNNN / MMMM` という略記の連なりで書き換えられずに残った参照を検出する — 書き換えの射程は広げない

- **状態**: 提案 (2026-09-23)
- **日付**: 2026-09-23

> **⚠ この ADR は、自動化された担い手（マネージャーから切り出された worker セッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 / 0200 / 0211 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` / `grep` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】は `origin/main` = `7ee4985`（2026-09-23、本 ADR の作業を
分岐した時点）の木、および同 sha から切った作業ブランチ
`fix/adr-renumber-detect-unrewritten-references` で行った。

---

## 問い

`scripts/adr-renumber-lib.mjs` の `rewriteReferencesInText` は、自分の docstring で
射程をこう宣言している（逐語）:

> 書き換えるのは次の2形だけ: 1. 旧ファイル名の stem（`NNNN-slug`）… 2. `ADR ` に続く
> 旧番号… **裸の4桁数字（上記どちらの形にもマッチしないもの）は一切変更しない。**

**この宣言のうち「`ADR ` に続く旧番号」は、「`ADR ` の直後という1箇所」しか見ない
実装になっている**（`adrRe = new RegExp(\`ADR ${oldNumber}(?!\\d)\`, "g")`）。⟹
🔴 **`ADR 0270 / 0271` という*略記の連なり*では、`/` の先の `0271` が「`ADR ` に続く」
形ではないため、`0271` が対象の oldNumber であっても一切書き換わらない。**

**これは想像上の穴ではない。**PR #614（`74c5295`）が実際に踏んだ。マージ直前、
`node scripts/adr-renumber.mjs` が PR #614 の ADR を `0271 → 0272` へ付け替えた際、
`scripts/__tests__/runtime-method-count-not-baked.test.mjs` の2箇所——

```
 73: *   （ADR 0269 の対象外、ADR 0270 / 0271 も引き継がない）。
116: describe("…（ADR 0269 引き受けた負債、ADR 0270 / 0271）", () => {
```

——が、リンク形式（`[ADR 0271](../../docs/decisions/0271-….md)`）は正しく `0272` へ
書き換わったにもかかわらず、この2箇所の**地の文の略記だけ旧番号のまま `main` へ焼かれた**。
`main` の ADR 0271 は無関係な別の決定（Issue #608 項目①、抽出候補の `subjectId`）を指す
ため、**この2箇所は着地した瞬間から間違った ADR を指していた**——しかも116行目は
`describe` の題なので、CI のテスト出力にそのまま出る。事後に PR #618（`bf6e9e7`）で人が
読んで `0271 → 0272` に直すまで、そのままだった。

**本 ADR は、このクラスの取りこぼしを機械的に *検出* して人に渡す一手を
`adr-renumber.mjs` に足す。⛔ 書き換えの射程は1バイトも広げない**（下の「採らなかった案」）。

## Issue #615 との関係 —— ⭐ 別の問い

[Issue #615](https://github.com/takecchi/mnemora/issues/615) は「ADR の採番と索引は
*共有された可変の資源*なのに、直列化の機構が無い」ことを実測で報告している——
**衝突がなぜ起きるか**（マージの直列化と、採番→CI→マージの一連の間に窓が空く）の話である。

**本 ADR はその先——衝突が実際に起きて `adr-renumber.mjs` が付け替えを実行した*あと*、
その付け替えが正しく行き渡ったかの話である。**⛔ **Issue #615 の「衝突そのものを直列化する」
予防策には踏み込まない。**Issue #615 は開いたまま・クローズもコメントもしていない
（指示により参照のみ）。

## 自分で測り直した — 区切り文字は `/` だけが実在する

`AGENTS.md`「⚠ 名乗れないものを道具に名乗らせない」「⚠ 偽陽性率に上限を置けない検査は
門にしない」に従い、射程を決める前に実測した:

```
$ git grep -hoE "ADR [0-9]{4}( ?[/・,、及びと] ?[0-9]{4})+" | sort | uniq -c | sort -rn | head -50
      9 ADR 0011/0025/0027/0028
      5 ADR 0008 / 0013 / 0026 / 0027 / 0044
      4 ADR 0152/0154
      4 ADR 0132 / 0137 / 0179 / 0199 / 0200 / 0211 / 0212 / 0234 / 0250
      4 ADR 0119/0120
      4 ADR 0088/0094
      3 ADR 0232/0235
      3 ADR 0170/0167
      ...（10連まで実在。省略した残りも含め、区切り文字は全件 `/`）

$ git grep -hoE "ADR [0-9]{4}( ?/ ?[0-9]{4})+" | wc -l
255
$ git grep -hoE "ADR [0-9]{4} / [0-9]{4}(( )?/ ?[0-9]{4})*" | wc -l
142
```

**⟹ 実在する区切りは `/` だけである。**`・`・`,`・`、`・`及び`・`と` を使った連なりの実例は
一件も無かった。⟹ **想像で足さない**——この検出の対象は `/` だけに絞る。**`/` の前後の
空白は有り無し両方が実在する**ので（`ADR NNNN/NNNN` と `ADR NNNN / NNNN` の両方が
多数）、両方を扱う。**連なりは2個で終わらない**——`ADR 0011/0025/0027/0028` のような
3連・4連や、さらに長い連なりも実在するので、任意の長さの連なりを対象にする。

## 決定

### 1. 検出だけを担う純関数 `findUnrewrittenAdrReferences(text, renames)` を足す

`scripts/adr-renumber-lib.mjs` に純関数として実装した（I/O を持たない。既存の
`rewriteReferencesInText` / `addedLineNumbers` と同じ設計）。

```js
const ADR_CHAIN_RE = /ADR \d{4}(?:[ \t]*\/[ \t]*\d{4})+/g;

export function findUnrewrittenAdrReferences(text, renames) {
  const oldNumbers = new Set(
    (renames ?? []).filter((r) => r.oldNumber !== r.newNumber).map((r) => r.oldNumber),
  );
  if (oldNumbers.size === 0) return [];

  const results = [];
  for (const chainMatch of text.matchAll(ADR_CHAIN_RE)) {
    const chain = chainMatch[0];
    const numbers = chain.match(/\d{4}/g) ?? [];
    // 1番目（"ADR " に直接続く数字）は rewriteReferencesInText 自身の射程なので
    // 対象から外す——ここで見るのは、その先の位置だけ。
    for (const number of numbers.slice(1)) {
      if (oldNumbers.has(number)) {
        results.push({ oldNumber: number, match: chain });
      }
    }
  }
  return results;
}
```

**主語の錨は `ADR` という語であり、区切りは実測で実在した `/` だけ。**連なりの**1番目**
（`ADR ` に直接続く数字）は既存の `rewriteReferencesInText` の `adrRe` が構造的に届く
位置なので、この関数は見ない（`.slice(1)`）——**この関数が報告するのは、既存の書き換えが
構造的に届かない位置だけである。**

### 2. `adr-renumber.mjs` の配線先 — 書き換えループの中、書き込みの直後

`performRenumber()` の中、`changedFiles` を走査して各追加行に `rewriteReferencesInText`
を当てているループ（`git mv` のあと・`renumberedReferenceWarning` の前）に配線した。

**なぜここか**: `findUnrewrittenAdrReferences` は「`rewriteReferencesInText` を当てた
*あとに何が残ったか*」を見る関数なので、同じ追加行・同じ `renames` を使い回せる
既存ループの中で呼ぶのが最も安全——別ループで独立に `git diff` を取り直すと、
「どのファイルのどの行が対象か」の判定基準（`addedLineNumbers`）が二重に実装されて
ずれる危険がある。

**⚠ 判断が要った点**: 検出対象を「`changes.length > 0` だった行だけ」にせず、**全ての
追加行**にした。PR #614 の事故そのものが「その行では `changes.length === 0`
（rewriteReferencesInText からは何も変わらなかった）のに、旧番号が残っていた」ケース
だったため——`changes` が空の行をスキップすると、この事故を再現できない検出になる。

書き換えが終わったあと、`unrewrittenHits` が1件以上あれば:
- `file:line` と該当行（trim 済み）・マッチした連なりを標準エラーへ列挙する
- **「人が読んで、正しい新番号へ手で直してください」と明記する**（⛔「機械が直す」とは
  言わない）
- `process.exitCode = 1` にする（`process.exit()` は使わない——ここまでの `console.log`
  が確実にフラッシュされてから終了するようにするため）

## 採らなかった案 —— `rewriteReferencesInText` の書き換え射程を広げる

🔴 **この案は採らなかった。**`ADR NNNN / MMMM` の2番目以降も拾うように `adrRe` を
広げれば、この事故そのものは機械的に直せるように*見える*。

**理由**: `AGENTS.md`「⚠ 機械には『検出』まで — 確定と書き込みは人に残す」の
「⭐ 線は『repo の中（戻せる）か、GitHub 側の取り消しにくい面か』である」節が言う通り、
`adr-renumber.mjs` は既に repo の中に書き込む道具である（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）——線は「機械が書き込むか」ではなく
「戻せるか」であり、repo 内の変更は `git` で戻せるので、その意味では射程を広げても
一見安全に見える。

**だが、この ADR が実際に線を引く場所は別にある**——**⛔ 書き込む道具は、間違えたときに
*静かに*壊れる。**射程を広げるほど、「たまたま `ADR NNNN / MMMM` の形をしているが、
2番目の `MMMM` は実は無関係な別の ADR への正当な言及だった」というケースを巻き込む
危険が増える。`rewriteReferencesInText` 自身の docstring が既に同じ理由で「裸の4桁数字は
日付・他の何かの識別子・無関係な4桁数字を巻き込むため触らない」と宣言しており、
連なりの2番目以降まで機械的に書き換える案は、**この宣言の精神——衝突している番号への
正当な言及は repo に大量にある——と正面から矛盾する。**「連なりの2番目だから、1番目と
同じ ADR を指しているはず」という前提は、**この ADR 自身が実測で確認していない**
（`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」と同じ形の判断）。

⟹ **検出（この ADR の関数）なら、偽陽性が出ても「人が確認する」だけで済む。**同じ道具
（`adr-renumber.mjs`）が、ファイル名・見出し・1番目の位置については既に「機械が書き込む」
側（ADR 0179 の実例）を、この2番目以降の位置については「検出だけ・確定と書き込みは
人に残す」側（[ADR 0211](./0211-check-pr-adr-reference-catches-abandoned-numbers-in-title-and-body.md) の実例と同じ形）を、**1本の道具の中で使い分けている。**

## 赤→緑の実測

### 赤（陽性対照 = PR #614 が実際に `main` へ焼いた文字列そのもの）

`scripts/__tests__/adr-renumber-lib.test.mjs` に `findUnrewrittenAdrReferences` の import
と、10本の `it` を先に足した（実装より前）。陽性対照2本の fixture は
`bakedLine1` / `bakedLine2` として、PR #618（`bf6e9e7`）の diff から逐語で取った
（`（ADR 0269 の対象外、ADR 0270 / 0271 も引き継がない）。` と、`describe` の題の文字列）。

```
$ pnpm exec vitest run scripts/__tests__/adr-renumber-lib.test.mjs
 FAIL  scripts/__tests__/adr-renumber-lib.test.mjs > findUnrewrittenAdrReferences … > 🔴 陽性対照1: 「ADR 0270 / 0271」の地の文で、0271 が付け替えられずに残った参照として報告される
TypeError: findUnrewrittenAdrReferences is not a function
 ❯ scripts/__tests__/adr-renumber-lib.test.mjs:274:18
（以下、同じ TypeError で計10件 red）

 Test Files  1 failed (1)
      Tests  10 failed | 31 passed (41)
```

**10件全て `findUnrewrittenAdrReferences is not a function`（関数が存在しないことによる
red）。既存の31件は無傷のまま緑。**

### 実装後の緑

```
$ pnpm exec vitest run scripts/__tests__/adr-renumber-lib.test.mjs
 Test Files  1 passed (1)
      Tests  41 passed (41)
```

### 配線後の統合確認（実際の `adr-renumber.mjs` を、衝突する ADR を足して走らせた）

作業ブランチ上に、`origin/main` で既に使われている番号 `0270` を名乗る使い捨ての
ADR ファイルと、`ADR 0269 / 0270` という連なりを含む別ファイルを作って `git add` し、
`node scripts/adr-renumber.mjs`（引数無し・実際の CLI）を走らせた:

```
$ node scripts/adr-renumber.mjs
衝突を検出しました（1 件）。付け替えます:
  git mv docs/decisions/0270-scratch-integration-test2.md docs/decisions/0275-scratch-integration-test2.md
docs/decisions/0275-scratch-integration-test2.md:
  "ADR NNNN" 表記: ADR 0270 -> ADR 0275（1 箇所）
（このブランチの他の変更ファイルの表記も同様に付け替わった——省略）
完了。1 本の ADR を付け替え、4 ファイルの参照を書き換えました。
⚠ ADR 番号を付け替えました（ADR 0270 -> ADR 0275）。
（PR タイトル・本文の警告、省略）

🔴 付け替えられずに残った参照が 1 件あります（`ADR NNNN / MMMM` のような略記の連なりの2番目以降は、この道具の書き換えが構造的に届きません）。
  docs/decisions/scratch-reference-holder2.md:3: ADR 0270 が残っています —— ADR 0269 / 0270
    （ADR 0269 の対象外、ADR 0269 / 0270 も引き継がない）。

⟹ 機械はここまでしか見ません。上の行を人が読んで、正しい新番号へ手で直してください（この道具は書き換えません——AGENTS.md「⚠ 機械には『検出』まで」）。
EXIT CODE: 1
```

**この道具（`node scripts/adr-renumber.mjs`）自身が、既存のリンク形式・見出しは正しく
`0270 → 0275` へ書き換えつつ、連なりの2番目に残った `0270` を検出して file:line で
名指しし、`exit 1` で終わることを実測した。**⚠ この統合確認は使い捨ての scratch
ファイルで行い、確認後に `git rm` で削除して `git status --porcelain` を空に戻した
（下記「測ったこと」参照。この統合確認自体は既存の `adr-renumber-lib.test.mjs` の
自動テストには含めていない——`vitest` の歯としては、純関数 `findUnrewrittenAdrReferences`
の10本の `it` が担う）。

## 変異試験 — 足りない側とやりすぎ側の両方

`cp` で退避・復元した（`git checkout` は使っていない）。

### 1. 足りない側 — 検出を無効化する

`findUnrewrittenAdrReferences` の本体を `return [];` に差し替えた:

```
$ pnpm exec vitest run scripts/__tests__/adr-renumber-lib.test.mjs
 Test Files  1 failed (1)
      Tests  4 failed | 37 passed (41)
```

**赤くなったのは、陽性対照を含む4本**（「🔴 陽性対照1」「🔴 陽性対照2」「rewriteReferencesInText
を先に通してから当てても…」「空振り防止: 3連・4連の略記でも…」）——**いずれも「検出できる
はず」の `it`。**`cp` で復元し、41 tests 全て緑に戻ることを確認した。

### 2. 🔴 やりすぎ側 — 裸の4桁数字まで拾うように広げる

`ADR_CHAIN_RE` によるチェーンの錨を外し、`text.match(/\d{4}/g)` で全ての4桁数字を
oldNumbers と突き合わせる実装に差し替えた:

```
$ pnpm exec vitest run scripts/__tests__/adr-renumber-lib.test.mjs
 ❯ scripts/__tests__/adr-renumber-lib.test.mjs (41 tests | 2 failed) 29ms
   × ⛔ 巻き込まない1: ADR の連なりの外に在る裸の4桁数字は報告しない
   × ⛔ 巻き込まない4: 連なりが無い単独の「ADR NNNN」は rewriteReferencesInText 自身の射程なので報告しない

AssertionError: expected [ Array(1) ] to deeply equal []
- []
+ [ { "match": "0271", "oldNumber": "0271" } ]

 Test Files  1 failed (1)
      Tests  2 failed | 39 passed (41)
```

**⭐ 守りの `it`（「巻き込まない1」「巻き込まない4」）が実際に赤くなった。**——射程を
広げると、`ADR の連なりの外に在る裸の4桁数字` と `連なりが無い単独の「ADR NNNN」` の
両方を誤検出するようになり、その両方を守る歯が反応した。⟹ **契約の両側（足りない・
やりすぎ）に歯が噛むことを実測した。**`cp` で復元し、41 tests 全て緑に戻ることを確認した。

### 3. 巻き込みが無いこと

- `scripts/__tests__/adr-renumber-lib.test.mjs`（41 tests）— 全て緑（他の既存31 tests は
  今回の変更で1件も壊れていない）。
- `pnpm exec vitest run scripts/__tests__/`（**85 test files / 1540 tests、2 skipped**）—
  全て緑。**同じ `scripts/` 配下の全歯を実行し、巻き込みが無いことを確認した。**
- `pnpm exec prettier --check` / `pnpm exec eslint` — 対象3ファイルとも緑。
- `git status --porcelain` — 空（下記「変更ファイル」参照。統合確認で作った scratch
  ファイルは全て `git rm` で削除済み）。

## ⛔ この検知が捕まえないもの

- **`ADR` の錨が無い裸の4桁数字**（日付・issue 番号・他の識別子）。連なりの外側は
  一切見ない——`rewriteReferencesInText` 自身の対象外という宣言をそのまま引き継ぐ。
- **`/` 以外の区切り**（`・`・`,`・`、`・`及び`・`と` 等）。上の実測でこの repo に実例が
  無いことを確認しただけであり、**新しい表記が今後現れたら、その時点でまた実測して
  射程を見直す必要がある。**
- **PR タイトル・本文**——`ADR NNNN / MMMM` の連なりがタイトル・本文に出た場合の検査は
  この関数の対象外。それは [ADR 0211](./0211-check-pr-adr-reference-catches-abandoned-numbers-in-title-and-body.md) の
  `scripts/check-pr-adr-reference.mjs` が別の仕組み（「このブランチが自分で名乗って
  自分で捨てた番号」を見る）で担う。
- **今日の実例（`runtime-method-count-not-baked.test.mjs` の2箇所）以外に、同種の
  取りこぼしが既に `main` の履歴に在るかは、掃いていない。**この ADR が足すのは
  「これから起きる付け替えでこのクラスの取りこぼしを検出する」検査であり、過去の
  取りこぼしを遡って見つける歯ではない。
- **連なりの1番目の位置**（`ADR ` に直接続く数字）は、`rewriteReferencesInText` 自身が
  正しく書き換える前提で、この関数の対象から意図的に外している——もし将来
  `rewriteReferencesInText` 側にこの位置の回帰が起きても、この関数はそれを検出しない
  （別の歯が要る）。

## 引き受けた負債

1. **検出は `process.exitCode` で伝わるだけであり、`adr-renumber.mjs` を手元で実行して
   出力を見る運用に依存する。**CI ジョブとしてこの CLI を自動実行する設計にはなって
   いない（ADR 0179 / ADR 0200 と同じ前提）。
2. **区切り文字の射程は「今日実測して実在したもの」に固定している。**新しい表記
   （例えば将来 `・` 区切りが実際に使われ始めたら）が出たら、その時点で実測し直して
   `ADR_CHAIN_RE` を見直す必要がある——**先回りして広げていない。**
3. **この検出は「連なり」という*特定の形*だけを見る。**PR #614 のように「`ADR ` に
   続かない位置に、対象の oldNumber がたまたま現れる」パターンが、連なり以外の形
   （例えば将来、別の記法が生まれた場合）で起きたら、この検出は届かない。

## これが覆るとしたら

- **採らなかった案（書き換えの射程を広げる）が覆るとしたら**——「連なりの2番目以降は
  常に1番目と同じ ADR を指す」ことを、この repo の実際の用例に対して実測で示せたとき
  である。今回はその実測をしていない（採らなかった理由は「実測していない前提の上に
  機械的な書き込みを置くのは、この repo の規律に反する」ことであり、「広げても安全だと
  示せる可能性が無い」ではない）。
- **区切り文字の射程が覆るとしたら**——`/` 以外の区切り（`・`・`,` 等）を使った
  `ADR NNNN` の連なりが実際にこの repo へ書かれたときである。そのときは同じ手順
  （`git grep` で実測）で射程を見直す。
- **この検出そのものが不要になるとしたら**——Issue #615 が扱う「衝突そのものを
  直列化する」対策が採られ、`adr-renumber.mjs` の付け替えが構造的に起きなくなった
  ときである（ただしそれは別の Issue の判断であり、本 ADR では決めていない）。

## 測ったこと

- 【実測】`git grep -hoE "ADR [0-9]{4}( ?[/・,、及びと] ?[0-9]{4})+"` — 実在する区切りは
  `/` だけ（`・`・`,`・`、`・`及び`・`と` の実例は0件）。3連・4連〜10連まで実在。
- 【実測】`git grep -hoE "ADR [0-9]{4}( ?/ ?[0-9]{4})+" | wc -l` → **255**。
- 【実測】空白ありの形（`ADR NNNN / NNNN...`）だけに絞ると → **142**。
- 【実測】赤: `pnpm exec vitest run scripts/__tests__/adr-renumber-lib.test.mjs` —
  実装前は **10 failed | 31 passed (41)**、全て `findUnrewrittenAdrReferences is not
  a function`。
- 【実測】緑: 実装後は **41 passed (41)**。
- 【実測】配線後の統合確認: `node scripts/adr-renumber.mjs`（実際の CLI）を、
  `origin/main` で衝突する ADR 番号 `0270` を持つ scratch ファイルと、
  `ADR 0269 / 0270` を含む別 scratch ファイルを足して走らせ、**付け替え（`0270 →
  0275`）は正しく実行しつつ、連なりの2番目に残った `0270` を `file:line` 付きで
  検出し `exit 1` で終わる**ことを確認した。scratch ファイルは確認後に `git rm` で
  削除し、`git status --porcelain` を空に戻した。
- 【実測】変異試験・足りない側: `findUnrewrittenAdrReferences` を `return [];` に
  差し替えると **4 failed | 37 passed (41)**——陽性対照を含む4本が赤くなった。
  `cp` で復元後、41 tests 全て緑に戻ることを確認した。
- 【実測】変異試験・やりすぎ側: チェーンの錨を外し裸の4桁数字まで拾う実装に
  差し替えると **2 failed | 39 passed (41)**——巻き込みを守る2本の `it` が赤くなった。
  `cp` で復元後、41 tests 全て緑に戻ることを確認した。
- 【実測】`pnpm exec vitest run scripts/__tests__/` — **85 test files（1 skipped）/
  1540 tests（2 skipped）**、全て緑。今回の変更が既存の歯を1件も壊していないことを
  確認した。
- 【実測】`pnpm exec prettier --check` / `pnpm exec eslint` — 変更した3ファイル
  （`scripts/adr-renumber-lib.mjs` / `scripts/adr-renumber.mjs` /
  `scripts/__tests__/adr-renumber-lib.test.mjs`）とも緑。
- 【実測】`node scripts/adr-renumber.mjs --next` → `0276`（`origin/main` の ADR 数
  265、他のリモートブランチ24本、open な PR 3本の ADR 主張を見た上での楽観的な
  次の番号。**この ADR のファイル名の番号はこの実測を根拠にした仮番号であり、
  マージ直前に `adr-renumber.mjs` の既定動作が確定させる**——ADR 0179 の設計通り）。

## 確かめていないこと

- **`docs/decisions/README.md`（索引）は本 ADR では書き換えていない。**マージ側が
  `generate-adr-index.mjs` を実行して再生成する規約（ADR 0137）に従い、触っていない。
- **既存の ADR 0179 / 0200 / 0211 / 0272 は1バイトも書き換えていない**——`git diff`
  で確認済みだが、この ADR 本文に個別のコマンド出力は貼っていない（変更は
  `git show --stat` に現れる差分そのもので確認できる）。
- **今日の実例以外に、同種の取りこぼしが `main` の履歴に既に存在するかは掃いていない**
  （上の「⛔ この検知が捕まえないもの」で明記済み）。
- **オーナー本人の確認は取っていない**（この ADR 自身の冒頭の警告の通り）。
