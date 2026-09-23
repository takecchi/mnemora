# ADR 0272: `Runtime` の非中核メソッド件数を検出する歯を、表記の軸だけ広げる（漢数字・「N つ」等）——主語の錨は外さない（ADR 0270 引き受けた負債、Issue #606 の材料）

- **状態**: 採用 (2026-09-23。[ADR 0283](./0283-adopt-merged-adrs-whose-decision-is-on-main.md) で担い手が「提案」から倒した——オーナー本人の判定ではない)
- **日付**: 2026-09-23

> **⚠ この ADR は、自動化された担い手（マネージャーから切り出された worker セッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**

**⚠ 各主張の出所を分ける**（ADR 0269 / 0270 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` / `grep` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】は `origin/main` = `bc60391`（2026-09-23、本 ADR の作業を
始めた時点）の木で行った。

---

## 問い

[ADR 0270](./0270-runtime-method-count-bake-detection-tooth.md) は
`scripts/__tests__/runtime-method-count-not-baked.test.mjs` を新設したが、
その正規表現（`[0-9]+個の(?:メソッド|口)`）は表記の軸を「算用数字＋助数詞『個』」1つだけに
絞っていた。同 ADR 自身が「確かめていないこと」に逐語で書いている:

> 漢数字（「九個」等）や「N つ」の形は当てていない——[Issue #606](https://github.com/takecchi/mnemora/issues/606)
> が引き受けた、生きた文書の数の焼き込みを一般形で掃く仕事の範囲であり、この歯は
> ADR 0269 が見つけた1つの実例（`docs/README.md` の `Runtime` 非中核メソッド件数）だけを
> 狙っている。

本 ADR は、この「確かめていないこと」のうち**表記の軸**（算用数字以外の数値表記、
助数詞「個」以外の助数詞）だけを引き受け、歯を広げる。

**⛔ 引き受けないもの（本 ADR の範囲外）**:
- **対象文書を4本から広げること**——掃引範囲の決定はオーナー領分であり、[Issue #606](https://github.com/takecchi/mnemora/issues/606)
  が引き受けている（下の「`#606` へ渡す材料」節）。
- **主語の錨（`メソッド`/`口`）を外すこと**——下の「なぜ主語の錨を外さないか」節で実測を示す。

---

## なぜ主語の錨を外さないか — 【実測】裸の数の分布

**ADR 0270 の正規表現は「N個の（メソッド|口）」という、主語が明示された形だけを見ている。
これを「裸の N つ」（`メソッド`/`口` に係らない、あらゆる数のカウント表現）まで広げると、
`main` が動いても変わらない側の数（中核5動詞の「5」・3層の「3」等）を大量に飲み込む。**

【実測】対象4文書（`README.md` / `docs/vision.md` / `docs/architecture.md` / `docs/README.md`）
を横断し、助数詞「個/つ/本/件」だけに絞って裸の数の出現を数えた:

```
grep -hoE "[0-9一二三四五六七八九十百]+(個|つ|本|件)" README.md docs/vision.md docs/architecture.md docs/README.md | sort | uniq -c | sort -rn | head -12
```

```
     10 2つ
      8 三つ
      7 5つ
      6 3つ
      6 1つ
      5 一つ
      4 一本
      4 6つ
      3 7件
```

⟹ **これらは大半が「中核5動詞の5」「3層の3」のような、`main` が動いても変わらない側の数
である。**主語の錨（`メソッド`/`口`）を外すと、この分布がそのまま偽陽性の候補になる
——`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」に反する。

**⟹ 本 ADR は主語の錨をそのまま残し、表記（算用数字/漢数字、助数詞の種類）の軸だけを広げる。**

---

## 決定1. 正規表現を広げる — 算用数字/漢数字 × 個/つ/本/件/箇所/種/通り

**広げる前**（ADR 0270、逐語）:

```js
const BAKED_METHOD_COUNT_RE = /[0-9]+個の(?:メソッド|口)/g;
```

**広げた後**:

```js
const KANJI_DIGITS = "[〇一二三四五六七八九十百千]+";
const COUNTER_WORD = "(?:個|つ|本|件|箇所|種|通り)";
const BAKED_METHOD_COUNT_RE = new RegExp(
  `(?:[0-9]+|${KANJI_DIGITS})${COUNTER_WORD}の(?:メソッド|口)`,
  "g",
);
```

**助数詞の集合**（個/つ/本/件/箇所/種/通り）は、[Issue #606](https://github.com/takecchi/mnemora/issues/606)
本文が一般形の掃引に使った助数詞集合（`[0-9]+(個|本|件|箇所|種|通り)`）に「つ」を足したもの——
「N つ」もこの規律の対象だと ADR 0270 の「確かめていないこと」が明示しているため。
**「個」以外の助数詞・漢数字を足しても、主語の錨（`の(?:メソッド|口)`）は変えていない。**

---

## 決定2. 4文書では赤が0件だった — ⛔ 「腐りが無い」とは言い切らない

【実測】広げたパターンを対象4文書に直接当てた:

```
grep -noE "[一二三四五六七八九十百]+(個|つ|本|件)の(?:メソッド|口)" README.md docs/vision.md docs/architecture.md docs/README.md
```
→ **0件**（exit 1）。

```
grep -noE "[0-9]+(つ|本|件|箇所)の(?:メソッド|口)" README.md docs/vision.md docs/architecture.md docs/README.md
```
→ **0件**（exit 1）。

広い助数詞集合（個|つ|本|件|箇所|種|通り、算用数字と漢数字の両方）でも実測した:

```
grep -noE "(?:[0-9]+|[一二三四五六七八九十百千]+)(?:個|つ|本|件|箇所|種|通り)の(?:メソッド|口)" README.md docs/vision.md docs/architecture.md docs/README.md
```
→ **0件**（exit 1）。

**⭐ 「赤が0件」は、それ自体が測定結果として正しい成果である。**⛔ **赤を出すために射程を
無理に広げていない**——上のパターンは、主語の錨を保ったままの自然な拡張である。

### 語順が逆の形（`メソッド…N個`）— 3件の判定

【実測】逆順も念のため実測した:

```
grep -noE "(メソッド|口)[^。]{0,20}[0-9]+個" README.md docs/vision.md docs/architecture.md docs/README.md
```
→ 0件（この助数詞では逆順ヒットなし）。

より広く「メソッド/口の近傍に数がある」形で確認すると、対象4文書で3件当たった。**この書き手が
本文を読んで判定した**:

1. **`docs/vision.md:72`**「（他の名で呼ばず）『6つ目の動詞』ではなく、中核を5つに保つために
   別の層へ出した口であり、**3つに分かれる**」——「3つ」は非中核メソッドの**分類の層数**
   （ADR 0171 が決めた3層）であり、`main` が動いても変わらない側。**Runtime の非中核
   メソッド件数ではない。⭕ 正当。**
2. **`docs/vision.md:102`**「代案として『recall() の戻り値にメソッドを生やす』『**6つ目の動詞**
   `reinforce()` を作る』も検討したが……却下した」——「6つ目」は却下した代案の呼び名
   （中核5動詞に足すなら6番目、という意味）であり、非中核メソッドの件数ではない。
   **⭕ 正当。**
3. **`README.md:255`**「（写せば `Runtime` に**メソッドが1本増えるたびに**腐る。`AGENTS.md`
   「⚠ 数を、道具と生成物に焼き込まない」……）」——「1本」は増分の単位（「メソッドが
   1本増えるたび」＝ 増えるごとに、という意味）であり、件数そのものの焼き込みではない。
   **⭕ 正当。**

⟹ **3件とも、この歯が捕まえるべき「Runtime の非中核メソッド件数の焼き込み」ではない。**
広げた歯（正順パターン）はこれらに当たらない——正順パターンはあくまで「数値＋助数詞＋の＋
（メソッド|口）」であり、上記3件はどれもこの語順を取っていない。

---

## 決定3. 赤→緑の証拠は変異試験で採る — 4本【実測】

**既存の腐りが無いため「赤を取ってから直す」形は使えない。**代わりに、`docs/README.md` へ
変異を注入し、(a) 広げた歯が赤くなること、(b) 広げる前の歯（ADR 0270 時点の正規表現）では
同じ変異が緑のままであること、を実測した。**すべて `cp` で退避・復元し、`git checkout` は
使っていない。**

### 変異1: `docs/README.md` に「九個のメソッド」（漢数字）を挿入

`docs/README.md`「## 外から見える API」節の「⛔ ここに個数を写さない」の直後に、
変異試験用の1文（「`Runtime` には他に九個のメソッドがある。実際には規律に反する。」）を挿入。

**広げた歯**（`pnpm exec vitest run scripts/__tests__/runtime-method-count-not-baked.test.mjs
scripts/__tests__/runtime-method-doc-correspondence.test.mjs`）:

```
❯ scripts/__tests__/runtime-method-count-not-baked.test.mjs (8 tests | 1 failed) 14ms
  docs/README.md    に在る: "九個のメソッド"

Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 11 passed (12)
```

**広げる前の歯**（ADR 0270 時点の正規表現、`git show HEAD:...` の内容を一時的に書き戻して
同じコマンドを実行）:

```
Test Files  2 passed (2)
     Tests  7 passed (7)
```

⟹ **同じ変異に対して、広げた歯だけが赤くなり、広げる前の歯は緑のままだった。**
**これが「広げたことに意味が在る」ことの証明である。**

### 変異2: `docs/README.md` に「9つのメソッド」（算用数字＋「つ」）を挿入

同じ箇所に「`Runtime` には他に9つのメソッドがある。実際には規律に反する。」を挿入。

**広げた歯**:

```
❯ scripts/__tests__/runtime-method-count-not-baked.test.mjs (8 tests | 1 failed)
  docs/README.md    に在る: "9つのメソッド"

Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 11 passed (12)
```

**広げる前の歯**（同じくADR 0270 時点の正規表現を一時的に書き戻して実行）:

```
Test Files  2 passed (2)
     Tests  7 passed (7)
```

⟹ **変異1と同じ結果——広げた歯だけが赤くなり、広げる前の歯は緑のままだった。**

### 巻き込みが無いこと

**変異1・変異2のどちらでも、`runtime-method-doc-correspondence.test.mjs`（ADR 0244 の歯、
4 tests）は一度も赤くならなかった**（上記出力の `Test Files 1 failed | 1 passed (2)` が、
2ファイル中1ファイルだけが赤いことを示している）。

### 復元の確認

すべて `cp` で退避したファイル（`docs/README.md` と、一時的に書き戻した
`runtime-method-count-not-baked.test.mjs`）を `cp` で元に戻し、`diff` で一致を確認した。
最終的に本 ADR の作業ツリーで `git status --porcelain` を実行し、意図した変更
（本 ADR ファイルの新規、テストファイルの拡張）以外に差分が残っていないことを確認した
——手順・出力は「枝名・commit・差分」節に記す。

---

## `#606` へ渡す材料 — ⛔ 仕分けない。件数だけを出す

**歯の対象は4文書のままだが、[Issue #606](https://github.com/takecchi/mnemora/issues/606)
が掃引範囲を決めるための材料として、広げたパターンが「生きた文書の全体」で何件当たるかを
測った。**⛔ **どれが腐りうる側かは決めない**（#606 の未決3点はオーナー領分）。

**対象**: `README.md` / `docs/*.md`（`docs/decisions/` を除く） / `packages/*/README.md` /
`examples/*/README.md`。【実測】ファイル一覧:

```
README.md, docs/README.md, docs/alteroid-findings.md, docs/architecture.md,
docs/autonomy.md, docs/conformance.md, docs/memory-model.md, docs/migration-v1.md,
docs/north-star.md, docs/recall.md, docs/release-notes-v1.0.0.md, docs/release-v1.md,
docs/roadmap.md, docs/vision.md, packages/anthropic/README.md, packages/core/README.md,
packages/local-embedding/README.md, packages/openai/README.md, packages/postgres/README.md,
packages/testkit/README.md, examples/chat/README.md
```

### A. `#606` 本文と同じコマンド・同じ助数詞集合（算用数字のみ）— **いまの値**

```
grep -rhoE "[0-9]+(個|本|件|箇所|種|通り)" README.md docs/*.md | wc -l
```

→ **524箇所**。⚠ **`#606` 本文は「517箇所」と書いている（`main` = `7a2c0c3` 時点）。
いまの値は524であり、7件増えている**（差分は主に `docs/conformance.md` 25→30、
`docs/memory-model.md` 12→15 の増分。`docs/README.md` は ADR 0270 の対処で 1→0 になった）。
⛔ **517をそのまま引き写していない。**

| 件数 | ファイル |
| ---: | --- |
| 176 | `docs/release-v1.md` |
| 125 | `docs/roadmap.md` |
| 60 | `docs/migration-v1.md` |
| 42 | `docs/recall.md` |
| 30 | `docs/conformance.md` |
| 25 | `docs/release-notes-v1.0.0.md` |
| 25 | `docs/autonomy.md` |
| 15 | `docs/memory-model.md` |
| 10 | `docs/architecture.md` |
| 9 | `README.md` |
| 6 | `docs/alteroid-findings.md` |
| 1 | `docs/vision.md` |
| 0 | `docs/README.md` |

### B. 同じ助数詞集合 + `packages/*/README.md` / `examples/*/README.md` も含める（#606 が
「確かめていないこと」に挙げていた範囲）

```
grep -hoE "[0-9]+(個|本|件|箇所|種|通り)" <21ファイル> | wc -l
```

→ **685箇所**。

| 件数 | ファイル |
| ---: | --- |
| 176 | `docs/release-v1.md` |
| 144 | `examples/chat/README.md` |
| 125 | `docs/roadmap.md` |
| 60 | `docs/migration-v1.md` |
| 42 | `docs/recall.md` |
| 30 | `docs/conformance.md` |
| 25 | `docs/release-notes-v1.0.0.md` |
| 25 | `docs/autonomy.md` |
| 15 | `docs/memory-model.md` |
| 10 | `docs/architecture.md` |
| 9 | `README.md` |
| 6 | `docs/alteroid-findings.md` |
| 6 | `packages/local-embedding/README.md` |
| 5 | `packages/postgres/README.md` |
| 4 | `packages/core/README.md` |
| 1 | `docs/vision.md` |
| 1 | `packages/anthropic/README.md` |
| 1 | `packages/testkit/README.md` |
| 0 | `docs/README.md`, `docs/north-star.md`, `packages/openai/README.md` |

### C. 一般形をさらに広げる — 漢数字・「N つ」を足す（本 ADR が新たに測った軸）

```
grep -hoE "(?:[0-9]+|[〇一二三四五六七八九十百千]+)(?:個|本|件|箇所|種|通り|つ)" <21ファイル> | wc -l
```

→ **1053箇所**。

| 件数 | ファイル |
| ---: | --- |
| 234 | `docs/release-v1.md` |
| 192 | `docs/roadmap.md` |
| 164 | `examples/chat/README.md` |
| 94 | `docs/recall.md` |
| 84 | `docs/migration-v1.md` |
| 50 | `docs/memory-model.md` |
| 48 | `docs/autonomy.md` |
| 41 | `docs/conformance.md` |
| 40 | `docs/release-notes-v1.0.0.md` |
| 33 | `docs/architecture.md` |
| 19 | `README.md` |
| 15 | `docs/vision.md` |
| 9 | `docs/alteroid-findings.md` |
| 7 | `packages/local-embedding/README.md` |
| 6 | `packages/postgres/README.md` |
| 5 | `docs/README.md` |
| 5 | `packages/core/README.md` |
| 2 | `packages/anthropic/README.md` |
| 2 | `packages/openai/README.md` |
| 2 | `packages/testkit/README.md` |
| 1 | `docs/north-star.md` |

**上位の内訳（出現した表記の実例。matchした文字列を集計、上位）**: `2つ`(97)・`1つ`(93)・
`1件`(91)・`1本`(84)・`0件`(59)・`6本`(49)・`3つ`(48)・`2件`(40)・`2本`(38)・`3件`(28)・
`二つ`(24)・`6つ`(22)・`7本`(20)・`4本`(20)・`6件`(19)・`5つ`(17)・`一つ`(16)・`4つ`(16)・
`30件`(13)・`1箇所`(13)・`12件`(13)・`三つ`(12)・`321件`(11)・`2箇所`(11) 等。

**⚠ この一般形（C）を眺めた限りの所感**（⛔ 仕分けではない。判定はオーナー領分）: 上位の
多くは「1つ」「0件」のような、文脈依存で数え上げが変わる自然な言い回しであり、`main` の
状態を焼き込んだ数とは限らない。**本 ADR はこの分類を一切行っていない**——
[Issue #606](https://github.com/takecchi/mnemora/issues/606) の未決1・2・3（腐りうる側の
個別 ISSUE 化・リリース関連文書の扱い・roadmap §5 の扱い）は、そのままオーナーへ残る。

### D. 主語に錨を打ったパターン（`(?:メソッド|口)` 側）— 広域

```
grep -hoE "(?:[0-9]+|[〇一二三四五六七八九十百千]+)(?:個|つ|本|件|箇所|種|通り)の(?:メソッド|口)" <21ファイル> | wc -l
```

→ **1箇所**（`docs/migration-v1.md:779`「1つの口」）。

**⚠ この1件は Runtime の非中核メソッド件数の焼き込みではない**（この書き手が本文を読んで
判定した）——文脈は「`applyCorrection` が `markContested` → `resolveContested` の書き込みを
**1つの口にまとめたもの**」であり、「Runtime に非中核メソッドが1個ある」という意味の
「口」ではなく、「1つの窓口・1つのインターフェースに集約した」という別の語義の「口」である。
⟹ **錨付きパターンでも、対象文書を広げると語義の違う偽陽性が出うることの実例。**
`docs/migration-v1.md` は本歯の対象4文書には含まれていない——この事実は「対象を広げてよい」
根拠にはしていない（対象は4本のままというオーナー決定を尊重した上での、参考情報としての
記録である）。

---

## ⛔ この歯が捕まえないもの（ADR 0270 からの引き継ぎ、変わらない部分）

1. 🔴 **プローズ中の箇条書き形の焼き込み**（ADR 0244 / 0270 が名指しした形）は対象外。
2. 🔴 **裸の「N つ」等**（主語の錨が無い数の焼き込み一般）は対象外——上の「なぜ主語の錨を
   外さないか」節の実測どおり、外すと偽陽性の山になる。**`Issue #606` の射程であり、本 ADR
   はそこまで広げない。**
3. 🔴 **対象文書は4本のまま**——`docs/README.md` を含む4本以外の生きた文書
   （`docs/roadmap.md` 等）は、本歯の対象外である。上の「`#606` へ渡す材料」節 D で見た
   `docs/migration-v1.md` の1件は、この歯には一切当たらない（対象外のファイルだから）。
4. 🔴 **`Runtime` 以外の interface のメソッド件数の焼き込み**は見ていない（ADR 0269 の対象外）。
5. 🔴 **仕分け**（`main` が動くと変わる側／変わらない側の判定）は行っていない——
   「`#606` へ渡す材料」節の集計は、すべて未仕分けの生の件数である。

---

## これが覆るとしたら何が起きたときか

- **[Issue #606](https://github.com/takecchi/mnemora/issues/606) の一般形の掃引が着地したとき**
  ——ADR 0270 と同じく、本歯が統合されるか廃止されるかは、その時点の担い手・オーナーが判断する。
- **対象4文書のいずれかで、`(?:メソッド|口)` が「Runtime の非中核メソッド件数」以外の語義で
  数値＋助数詞と隣接する形が実際に書かれたとき**——「`#606` へ渡す材料」節 D の
  `docs/migration-v1.md` の実例（「1つの口」＝窓口の意味）が、対象4文書の中でも将来起こり
  うる。そのときは本歯が偽陽性を出す。決定2 の実測時点（4文書・`bc60391`）では起きていない。
- **助数詞の集合（個/つ/本/件/箇所/種/通り）に無い新しい助数詞**（例: 「N 種類」「N 通り」の
  変化形、算用数字と漢数字の混在表記）**で同じ内容が書かれたとき**——本歯はそれを捕まえない。

## 採らなかった案

### 1. 裸の「N つ」まで拾う（主語の錨を外す）

⛔ **「なぜ主語の錨を外さないか」節の実測（4文書で裸の数が62箇所以上、上位だけで
「2つ」10件・「三つ」8件等）が示すとおり、`main` が動いても変わらない側の数を大量に
飲み込む。**`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」に反する。

### 2. 対象文書を4本から広げる

⛔ **掃引範囲の決定はオーナー領分**——タスクの明示的な制約であり、また
[Issue #606](https://github.com/takecchi/mnemora/issues/606) 自身が「掃引範囲は着手時に
決め直すこと」と指示している。本 ADR は「`#606` へ渡す材料」節で件数を測るところまでに
留め、対象は広げていない。

### 3. 赤が0件だったので、本 ADR・広げた歯を作らない

⛔ **`AGENTS.md`「⚠ 『出なかった』を、事象が無いことの証明にしない — 先に陽性対照を示す」**
に従い、「表記の軸を広げても4文書では当たらなかった」こと自体を、陽性対照と変異試験つきで
記録する意味がある——**将来同じ形で漢数字・「N つ」表記の腐りが起きたとき、この歯が捕まえる
という保証を、いま作っておくこと自体が価値である。**「赤が出なかったから何もしない」は
ADR 0270 の「確かめていないこと」を未解決のまま放置することになる。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 【実測】4文書に対する狭い錨付きパターン（漢数字＋個|つ|本|件、算用数字＋つ|本|件|箇所）
  それぞれ単独、および広い助数詞集合（個|つ|本|件|箇所|種|通り、算用数字/漢数字の両方）
  ——いずれも0件。
- 【実測】逆順パターンで当たった3件（`docs/vision.md:72`・`docs/vision.md:102`・
  `README.md:255`）を自分で読み、いずれも Runtime の非中核メソッド件数の焼き込みでは
  ないと判定した。
- 【実測】変異試験2本（漢数字「九個」、算用数字＋つ「9つ」）——広げた歯は赤、広げる前の歯
  （ADR 0270 時点の正規表現）は緑のまま。`runtime-method-doc-correspondence.test.mjs`
  （4 tests）は両方の変異で一度も赤くならなかった。すべて `cp` で退避・復元し、`diff` で
  一致を確認し、`git status --porcelain` が空であることを確認した。
- 【実測】`pnpm exec eslint scripts/__tests__/runtime-method-count-not-baked.test.mjs`
  （警告0）、`pnpm exec prettier --check` 同ファイル（成功）。
- 【実測】`pnpm exec vitest run scripts/`（85 test files passed / 1 skipped、
  1530 tests passed / 2 skipped）——衝突・巻き込みが無いことの全体確認。
- 【実測】`#606` へ渡す材料——A（`#606` と同じコマンド・4パターン、524箇所、517からの
  差分+7）、B（`packages/*/README.md` / `examples/*/README.md` を含めて685箇所）、
  C（漢数字・「N つ」を足して1053箇所）、D（主語に錨を打った広域パターン、1箇所、
  Runtime のメソッド件数ではないと判定）。
- 【実測】`node scripts/adr-renumber.mjs --next` → `0271`（本 ADR の仮番号。マージ直前に
  マネージャー側で確定し直される前提、ADR 0179）。

### 確かめていないこと

- ⛔ **`#606` の未決3点**（腐りうる側の個別 ISSUE 化の粒度、リリース関連文書の扱い、
  `docs/roadmap.md` §5 の扱い）**は、本 ADR では一切判断していない**——「`#606` へ渡す材料」
  節はすべて未仕分けの生の件数である。
- ⛔ **ルートの `pnpm run test`（全体、typecheck/lint/format/build を含むフルスイート）は
  走らせていない**——本 ADR の変更は `scripts/__tests__/` のテストファイル1本（既存拡張）と
  本 ADR のみであり、`packages/` のビルド・型・他パッケージのテストには触れていない。
- ⛔ **`packages/postgres` の DB テスト・実 API を通した経路は確認していない。**
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーのとおり、これはクローンの判定である）。
- ⛔ **助数詞集合（個/つ/本/件/箇所/種/通り）が将来の文書の書き方の変化にも狭いままかは、
  今回の実測時点（`bc60391`）でしか確かめていない。**
- ⛔ **`docs/migration-v1.md:779`「1つの口」以外にも、対象外文書で同じ語義違いの偽陽性が
  在るかは、網羅的には確かめていない**——「`#606` へ渡す材料」節 D の1件を見つけたのみで、
  全件を人手で読んではいない。
