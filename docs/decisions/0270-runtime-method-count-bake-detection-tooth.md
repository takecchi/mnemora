# ADR 0270: `Runtime` の非中核メソッド「件数」が生きた文書へ焼き込まれることを検出する歯を足す — 値ではなく形を見る（ADR 0269 引き受けた負債）

- **状態**: 提案 (2026-09-23)
- **日付**: 2026-09-23

> **⚠ この ADR は、自動化された担い手（マネージャーから切り出された worker セッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**

**⚠ 各主張の出所を分ける**（ADR 0244 / 0269 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】【現物】は `origin/main` = `f572676`（2026-09-23、本 ADR の作業を
始めた時点）の木で行った。

---

## 問い

[ADR 0269](./0269-port-interface-doc-correspondence-sweep.md)「引き受けた負債」節は、掃引の本題
（`Runtime` 以外の port interface）の枠外で、次を見つけて記録していた（逐語）:

> ⭐ **`docs/README.md:40` の「`Runtime` には他に9個のメソッドがあるが」は、いま実際にずれている。**
> 【実測】`packages/core/src/runtime.ts` の `export interface Runtime` を機械的に数え直すと
> 17メソッド・非中核12（ADR 0244 と同じ数え方・同じ結果）。（中略）ADR 0244 の歯
> （`scripts/__tests__/runtime-method-doc-correspondence.test.mjs`）は `README.md`/`docs/vision.md`/
> `docs/architecture.md` の3文書しか見ておらず、**`docs/README.md`（ルート `README.md` とは
> 別ファイル）は対象に入っていない。**⟹ 既存の歯が捕まえない第4のファイルで、まさに歯が
> 防ごうとした形の腐りが実際に起きている。**この事実だけをここに記録し、対処（歯の対象を
> 広げる／`docs/README.md` を直す／別 Issue を立てる）はオーナーへ返す。**

本 ADR は、その対処のうち「歯を足す」「`docs/README.md` を直す」の2つを実行した記録である。
**ただし、直すだけでは同じ形の腐りがまた起きる**（[Issue #518](https://github.com/takecchi/mnemora/issues/518)
本文が予告し、翌日に `applyCorrection` で現実になった腐り方——ADR 0244「文脈」節）。
⟹ **先に検出する歯を置き、その歯が実際に噛む（赤→緑→変異試験）ことを示してから、文書を直す。**

---

## 🔴 決定0. `docs/README.md` を ADR 0244 の `LIVE_DOCS` にそのまま足す道は採らない — 実測で確かめた

**先に、素朴な道（ADR 0244 の歯の `LIVE_DOCS` 配列に `docs/README.md` を足すだけ）を実際に試し、
赤の出力を確かめた。**

【実測】`scripts/__tests__/runtime-method-doc-correspondence.test.mjs` の `LIVE_DOCS` に
`{ label: "docs/README.md", path: docsReadmePath }` を1行足し、
`pnpm exec vitest run scripts/__tests__/runtime-method-doc-correspondence.test.mjs` を実行すると、
4 tests 中 1 failed で次が出た（逐語）:

```
AssertionError: Runtime のメソッドが、生きた文書で名指しされていない:

  docs/README.md    に無い: tick
  docs/README.md    に無い: getRecall
  docs/README.md    に無い: findCorrectionCandidates
  docs/README.md    に無い: reextract
  docs/README.md    に無い: reembed
  docs/README.md    に無い: sweepArchive
  docs/README.md    に無い: restoreArchived
  docs/README.md    に無い: restoreSuperseded
  docs/README.md    に無い: purge
  docs/README.md    に無い: markContested
  docs/README.md    に無い: resolveContested
  docs/README.md    に無い: applyCorrection

⟹ どうすればよいか:
  packages/core/src/runtime.ts の `export interface Runtime` に口を足したら、
  上の文書の「中核を守る3つの層」の節に、その名前を `バッククォート付き` で書くこと。
  ⭐ 3層のどれに分類するかは意味の判定であり、この歯は縛っていない。
     分類が決まらないなら「どの層にも置かれていない」側に名指しするだけでよい
     （README.md / docs/vision.md / docs/architecture.md に既にその形が在る）。
  ⛔ この歯を満たすために、個数を文書へ書き戻さないこと
     （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。
```

**この赤を満たす唯一の道は、`docs/README.md`（文書の地図。「何が書いてあるか」を1文で
案内するファイル）に非中核12メソッドの名前を全部 `` `name` `` の形で書き込むことである。**
⟹ 🔴 **それは #604（[Issue #604](https://github.com/takecchi/mnemora/issues/604)）が名指しした
「文書がインターフェースの写しを持つ」罪そのものを、`docs/README.md` に新しく作ることになる。**
`docs/README.md` は「文書の地図」であり `docs/vision.md`「外から見える API」の詳細説明の
役割を持たない（`docs/README.md` 自身の冒頭「ここに在るのは設計判断とその理由である」・
「読む順」の表を見ること）。

**⟹ 本 ADR はこの道を採らない。** 実験後、`cp` で退避したファイルを `cp` で復元し、
同じ4 tests が全緑に戻ることを確認した（`diff` で一致も確認）。

---

## 決定1. 「件数」を検出する、別の・独立した歯を足す

⭐ **ADR 0244 の歯は「名前の集合」を見ている。件数は見ていない**
（ADR 0244 決定5・「歯が縛るのは名前の集合だけである」）。**`docs/README.md:40` が壊れた形は
これとは別の形——「9個」という*数*が古くなった**（ADR 0244「文脈」節が引く Issue #518 の
出発点と同じ形）。⟹ **検出すべきは「件数が焼き込まれていること自体」であり、既存の歯が
検出する対象（名前の集合の欠落）とは別物である。**同じファイルに `it` を足すことも検討したが、
**検査する対象・検査しない対象・正規表現の設計根拠が別物であるため**、独立したファイル
（`scripts/__tests__/runtime-method-count-not-baked.test.mjs`）に分けた——
**ADR 0244 の歯（本体）に触れず（Issue の指示・本タスクの指示のどちらでも、既存の歯を
書き換えないことが求められている）、レビューの単位を1つの主張＝1ファイルに保つため。**

### 決定1.1 対象は4文書 — README.md / docs/vision.md / docs/architecture.md / docs/README.md

ADR 0244 の3文書に `docs/README.md` を足した4文書とする。ADR 0244 の対象を狭めない
（ADR 0244 が縛る「名前の集合」の不変条件はそのまま残る）。

### 決定1.2 「正しい件数か」ではなく「件数が焼き込まれていること自体」を赤にする

⛔ **この歯は `Runtime` の実メソッド数を一度も数えない**——`packages/core/src/runtime.ts` を
読みすらしない。**「17個」に書き直しても、この歯は依然として赤である**——直すべきは
値ではなく、数を書かない*形*にすることだからである（下の「歯が噛むことを示した」節、
変異試験1）。

### 決定1.3 総数・件数を歯の中に literal で持たない

ADR 0244 決定4 が `CORE_VERBS`（中核5動詞、`main` が動いても変わらない側）だけを literal で
持つのと同じ作法に揃える。**本歯が検査する対象（Runtime の非中核メソッドの「件数」という値）
自体が `main` で動く側なので、そもそも literal で持つ余地が無い**——この歯は `Runtime` の
メソッド数をどこにも持たない（`packages/core/src/runtime.ts` を parse しないので、ADR 0244 の
歯のような抽出関数も無い）。

### 決定1.4 正規表現を狭く取る — 4文書を横断 grep して実測した

`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」に従い、**対象4文書に対して
実際に正規表現を走らせ、狙った1件以外に当たらないことを実測してから採用した。**

【実測】対象4文書を横断し、助数詞付きの数値表記を機械的に洗い出した:

```
grep -noE "[0-9]+(個|本|件|箇所|種|通り|つ)" README.md docs/vision.md docs/architecture.md docs/README.md
```

→ 62箇所ヒット（`5つ`〔中核5動詞〕・`3つ`〔3層〕・`2つ`・`7件`・`1本`等、`main` が動いても
変わらない側や、この歯の対象外の数が大半）。**この中から「個の」＋「メソッド」または「口」という
組み合わせだけに絞ると:**

```
grep -noE "[0-9]+個の(メソッド|口)" README.md docs/vision.md docs/architecture.md docs/README.md
```

→ **1件のみ**: `docs/README.md:40:9個のメソッド`。

⟹ **`[0-9]+個の(?:メソッド|口)` という正規表現は、現状の4文書に対して狙った1箇所にしか
当たらない**（実測。「5つ」「3つ」のような、この repo で `main` が動いても変わらない側の数は
「N個の」という助数詞の形を取っていないため、当たらない）。**「口」も含めたのは、
`docs/vision.md`「別の層へ出した口」・`README.md`「別の層へ出した口」のように、この repo が
非中核メソッドを指すのに「口」という語も使っているため**（将来同じ形で「N個の口」と
焼き込まれた場合も捕まえるための予防的な広さであり、現状ヒットするのは「メソッド」側の
1件のみ）。

---

## 決定2. 失敗メッセージに「数を書かない形にすること」を明示する

ADR 0244 決定7 と同じ理由——検査が存在するだけでは、誰が何をすればよいか分からない。
**「正しい件数に直せ」と読めないよう、逐語で「数を*正しい件数に書き直す*のではなく、
数を書かない形に変えること」と書く。**（下の「歯が噛むことを示した」節の赤い出力を見ること。）

## 決定3. 新しい CI ジョブ・新しいステップを足さない

ADR 0244 決定6・ADR 0212 決定6 と同じ論拠——`vitest.config.mts` の
`include: ["scripts/**/*.test.mjs"]` に相乗りし、required ジョブ `test` の `pnpm run test` で走る。

## 決定4. `docs/README.md:40` の直し方 — 唯一の出所を指すだけにする（「数を言わない」ではなく）

⭕ **採った形**: 個数を言わず、正本（`packages/core/src/runtime.ts` の `export interface Runtime`）を
指す。**理由**: `README.md`「`Runtime` の中核5動詞以外 — 中核を守る3つの層」節と
`docs/vision.md`「中核を守る3つの層」節が、**ADR 0244 の作業で既にこの形に直っている**
（逐語「⭐ **何が在るかの正本は `packages/core/src/runtime.ts` の `export interface Runtime` である**
——⛔ **ここに個数を写さない**」）。⟹ **同じ文言・同じ形を `docs/README.md` にも当てることで、
3文書が既に採用している言い回しに揃え、4本目だけが違う言い方をする不整合を避けた。**

⛔ **採らなかった形**: 「9個」を「17個」に書き直す。**ADR 0244 の「文脈」節が実測した通り、
数だけを直しても `main` が動けばまた古くなる**——同じ罪をもう一度犯すことになる。

具体的な差分（前後とも `docs/README.md` の「## 外から見える API」節）:

**直す前**【現物】:

```
**記憶そのものを動かす中核**は `observe()` / `recall()` / `reflect()` / `consolidate()` /
`forget()` の5つ。**ここは増やさない。**`Runtime` には他に9個のメソッドがあるが、
保守操作・是正取り消し・説明の3層に分かれる（[docs/vision.md](./vision.md)「外から見える
API」、[ADR 0171](./decisions/0171-five-verbs-plus-three-layers.md)）。
```

**直した後**【現物】:

```
**記憶そのものを動かす中核**は `observe()` / `recall()` / `reflect()` / `consolidate()` /
`forget()` の5つ。**ここは増やさない。**`Runtime` には他にもメソッドがあるが、⭐ **何が
在るかの正本は `packages/core/src/runtime.ts` の `export interface Runtime` であり、
⛔ ここに個数を写さない**（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。それらは
保守操作・是正取り消し・説明の3層に分かれる（[docs/vision.md](./vision.md)「外から見える
API」、[ADR 0171](./decisions/0171-five-verbs-plus-three-layers.md)）。
```

**この節が伝えようとしていたこと（中核5動詞は固定・非中核は3層に分かれる）は変えていない**
——変えたのは「非中核の個数」という、崩れやすい一言だけである。

---

## 歯が噛むことを示した【実測】

`scripts/__tests__/runtime-method-count-not-baked.test.mjs`（vitest、3 tests）。

| 検査                                         | it                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| 陽性対照（検出器が実際に捕まえることの証明） | `陽性対照: 検出器は、焼き込まれた件数の実例を実際に捕まえる（空回り防止）` |
| 本体（4文書のどれも焼き込んでいない）        | `4本の生きた文書のどれも、Runtime の非中核メソッド件数を焼き込んでいない`  |
| 4文書が実在して空でない（空回り防止）        | `この歯が読んでいる4文書が、実在して空でない`                              |

### 赤（`docs/README.md` を直す前）【実測】

```
pnpm exec vitest run scripts/__tests__/runtime-method-count-not-baked.test.mjs
```

```
 ❯ scripts/__tests__/runtime-method-count-not-baked.test.mjs (3 tests | 1 failed) 10ms
   ❯ Runtime の非中核メソッド件数が、生きた文書に焼き込まれていない（ADR 0269 引き受けた負債、ADR 0270） (3)
     × 4本の生きた文書のどれも、Runtime の非中核メソッド件数を焼き込んでいない 6ms

AssertionError: 生きた文書に、Runtime の非中核メソッド件数が焼き込まれている:

  docs/README.md    に在る: "9個のメソッド"

⟹ どうすればよいか:
  数を*正しい件数に書き直す*のではなく、数を書かない形に変えること。
  正本は packages/core/src/runtime.ts の `export interface Runtime` である。
  件数を言わずに書くか、唯一の出所（上記ファイルの `export interface Runtime`）を
  指すだけにすること（README.md「`Runtime` の中核5動詞以外」・docs/vision.md
  「中核を守る3つの層」に、既にその形が在る）。
  ⛔ この歯を満たすために「N個」を別の数へ書き換えないこと
     （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

### 緑（決定4 の直しを適用した後）【実測】

```
pnpm exec vitest run scripts/__tests__/runtime-method-count-not-baked.test.mjs scripts/__tests__/runtime-method-doc-correspondence.test.mjs
```

```
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

### 変異試験【実測】（`cp` で退避・復元。⛔ `git checkout` は使っていない）

1. **`docs/README.md` に「17個」と書き戻す変異**（node スクリプトで、決定4の直した文から
   「17個のメソッドがあるが、それらは」の形へピンポイントに戻す）——
   `pnpm exec vitest run scripts/__tests__/runtime-method-count-not-baked.test.mjs
scripts/__tests__/runtime-method-doc-correspondence.test.mjs` を実行すると:

   ```
   ❯ scripts/__tests__/runtime-method-count-not-baked.test.mjs (3 tests | 1 failed) 11ms
     docs/README.md    に在る: "17個のメソッド"

   Test Files  1 failed | 1 passed (2)
        Tests  1 failed | 6 passed (7)
   ```

   **新しい歯（`runtime-method-count-not-baked.test.mjs`）だけが赤くなり、既存の歯
   （`runtime-method-doc-correspondence.test.mjs`）は4 tests とも緑のままだった。**
   ⭐ **「9」でも「17」でも同じ `it` が赤くなる——これは値ではなく*形*を見ていることの
   証明である。** `cp` で復元後、`diff` で一致を確認し、同じ7 tests が全緑に戻ることを
   実測した。

2. **`docs/vision.md`「中核を守る3つの層」の直後に、同じ形の1文
   （「`Runtime` には他に12個のメソッドがある（変異試験用に挿入した1文。実際には規律に
   反する）。」）を挿入する変異**——同じ2ファイルを実行すると:

   ```
   ❯ scripts/__tests__/runtime-method-count-not-baked.test.mjs (3 tests | 1 failed) 11ms
     docs/vision.md    に在る: "12個のメソッド"

   Test Files  1 failed | 1 passed (2)
        Tests  1 failed | 6 passed (7)
   ```

   **対象4文書のうち `README.md` / `docs/architecture.md` 以外の場所（`docs/vision.md`）に
   同じ形の焼き込みを入れても、新しい歯が捕まえた。**⟹ **4文書を実際に見ていることの
   確認。**`cp` で復元後、`diff` で一致を確認し、同じ7 tests が全緑に戻ることを実測した。

3. **巻き込みが無いことの確認**: 上記1・2の両方で、**新しい歯（3 tests 中1つ）だけが
   赤くなり、既存の歯（`runtime-method-doc-correspondence.test.mjs`、4 tests）は
   一度も赤くならなかった**（上の出力の `Test Files  1 failed | 1 passed (2)` が、
   1ファイルだけが赤いことを示している）。

`eslint scripts/__tests__/runtime-method-count-not-baked.test.mjs` — 成功（警告0）【実測】。
`prettier --check scripts/__tests__/runtime-method-count-not-baked.test.mjs docs/README.md` ——
**新しいテストファイルは成功。`docs/README.md` は警告**【実測】。⚠ ただし
**この警告は本 PR が持ち込んだものではない**——【実測】本 PR の変更を `git stash` で
一時的に外した状態でも `prettier --check docs/README.md` が同じ警告を出すことを確認した
（ADR 0244 が README.md / docs/vision.md / docs/architecture.md について記録した既存の状態と
同じ形）。

`pnpm exec vitest run scripts/` — **85 test files / 1520 tests、全緑**【実測】
（衝突・巻き込みが無いことの全体確認）。

---

## ⛔ この歯が捕まえないもの

⚠ **検査が存在することは、それが何を保証するかを何も言っていない。⟹ この節を消さないこと。**

1. 🔴 **プローズ中の*箇条書き形*の焼き込み**——ADR 0244 の歯が実際に対象にしている「メソッド
   _名前の列挙_」が腐る形（`Runtime` が3文書で実際に踏んだ形そのもの）は、本歯の対象外である。
   **本歯が見るのは「件数」という1個の数値だけであり、「行頭に `interface X {` がある」ような
   構文パターンでは足りない**——[Issue #604](https://github.com/takecchi/mnemora/issues/604) /
   [ADR 0269](./0269-port-interface-doc-correspondence-sweep.md) が確かめていないことに挙げた、
   `docs/architecture.md` §5 のような「interface 宣言をコードブロックごと再掲する」形の焼き込み
   （箇条書き・コードブロックの写し）は、本歯の正規表現（`[0-9]+個の(?:メソッド|口)`）には
   一切当たらない。**その形を捕まえるには、ADR 0269 決定3 がやったような、コードブロックを
   括弧対応で切り出して実体と突き合わせる、別の・もっと重い検査が要る。**
2. 🔴 **漢数字・「N つ」の形は当てていない。** 「九個」「9つのメソッド」のような表記は
   `[0-9]+個の(?:メソッド|口)` に当たらない。⟹ **これらの形で同じ内容が焼き込まれても、
   本歯は緑のままである。**この一般形の掃引・仕分けは
   [Issue #606](https://github.com/takecchi/mnemora/issues/606) が引き受けている範囲であり、
   本 ADR はそこまで射程を広げない——本歯は ADR 0269 が見つけた1つの実例だけを狙っている。
3. 🔴 **`Runtime` 以外の interface（`MemoryStore` 等）のメソッド件数の焼き込みは見ていない。**
   [ADR 0269](./0269-port-interface-doc-correspondence-sweep.md) 決定3 が見つけた `MemoryStore`
   （15 vs 25）・`VectorStore`（3 vs 4）・`TenantSettingsStore`（1 vs 8）の drift は、
   件数の焼き込みというよりインターフェース宣言そのものの写しが古いという別の形であり、
   同 ADR 自身が「直さない」と明記している。本歯もその方向を引き継がない。
4. 🔴 **文書の「どこに」書かれているかは見ていない。** 4文書のまったく無関係な場所に
   同じ形の数値が1度出ていれば、それが `Runtime` のメソッド件数の話でなくても
   `[0-9]+個の(?:メソッド|口)` という*文字列の形*に一致すれば赤になる——**意味的に
   `Runtime` の話かどうかを判定していない。**（逆に言えば、`Runtime` の話ではない
   正当な「N個のメソッド」という言い回しが将来 生まれた場合、偽陽性になりうる。
   決定1.4 の横断 grep では現状ヒットしなかったため、いまは実害が無い。）

⭐ **⟹ この歯が実際に止めるのは、ADR 0269 が見つけた形1つだけである**——
**`Runtime` の非中核メソッド件数が、`docs/README.md` を含む4本の生きた文書のどこかに
「N個の(メソッド|口)」という形で書き戻されること。**⛔ **それ以上のことは主張しない。**

---

## 引き受けた負債

- **上の「⛔ この歯が捕まえないもの」4項目**、特に1番（プローズ中の箇条書き形）と2番
  （漢数字・「N つ」等の未対応の表記）。
- **`docs/README.md` の直し方（決定4）は、ADR 0244 が既に確立した言い回しを踏襲しただけであり、
  「文書の地図であるファイルにどこまで詳細な説明を書いてよいか」という、より広い編集方針の
  問いには答えていない。**
- **正規表現（`[0-9]+個の(?:メソッド|口)`）は、現状の4文書に対してのみ狭さを実測した。**
  文書の文言が今後大きく書き換わったとき、同じ狭さが保たれる保証は無い——
  そのときは決定1.4 と同じ横断 grep をもう一度実測し直すこと。

## これが覆るとしたら何が起きたときか

- **[Issue #606](https://github.com/takecchi/mnemora/issues/606) の一般形の掃引が着地したとき**——
  漢数字・「N つ」等を含む、より広い検出器に統合される可能性がある。**そのときは本歯を
  廃止して統合するか、共存させるかを、その時点の担い手が判断すること。**
  本 ADR はそれを予断しない。
- **`docs/README.md`「## 外から見える API」節が書き直されたとき**（決定4 の文言が変わる）、
  または `Runtime` interface の宣言の形が変わったとき——`it` 1（陽性対照）が先に落ちる
  可能性がある。

## 採らなかった案

### 1. ADR 0244 の `LIVE_DOCS` に `docs/README.md` を足すだけ

⛔ **決定0 で実測した通り、それは非中核12メソッドの名前を `docs/README.md` へ列挙することを
強制し、#604 / ADR 0269 が名指しした罪をこの文書に新しく作ることになる。**

### 2. `docs/README.md:40` を「9個」→「17個」に書き直すだけ（歯を作らない）

⛔ **ADR 0244「文脈」節が実測した通り、数だけを直しても `main` が動けばまた古くなる**——
実際に「9」は PR #344（2026-09-16）以来放置され、その後3メソッドが増えても直っていない
（ADR 0269「引き受けた負債」節）。**検出する歯を置かずに直すだけでは、同じ腐りが再発する。**

### 3. 1つの歯に、名前の集合の検査（ADR 0244）と件数の検査（本 ADR）を統合する

⛔ **既存の歯（ADR 0244 の歯）を書き換えないことが、本タスクの明示的な制約であり、また
ADR 0244 自身の不変条件（「名前の集合だけを縛る」）を変えないことにもなる。**検査対象・
正規表現の設計根拠が別物であるため、統合すると「なぜこの歯が2つのことを見ているか」の
説明が重くなる——ADR 0244 の歯と対称的に、1つの ADR には1つの検査主張、という形を保った。

### 4. `docs/README.md` の該当文を単純に削除する（節ごと消す）

⛔ **「中核5動詞は増やさない」「非中核は3層に分かれる」という、この節が伝えている情報
自体は正しく、消す理由が無い。** 消したい・古くなるのは「件数」という一言だけである。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 【実測】決定0: `LIVE_DOCS` に `docs/README.md` を足した素朴な道を実際に試し、赤の出力
  （非中核12メソッド名が全部 `docs/README.md` に無いと言われること）を確認し、`cp` で復元、
  同じ4 tests が全緑に戻ることを確認した。
- 【実測】決定1.4: 対象4文書を横断する `grep -noE "[0-9]+(個|本|件|箇所|種|通り|つ)"`
  （62箇所）と `grep -noE "[0-9]+個の(メソッド|口)"`（1箇所のみ、`docs/README.md:40`）。
- 【実測】新しい歯（`runtime-method-count-not-baked.test.mjs`）の赤（直す前）・緑（直した後）。
- 【実測】`docs/README.md:40` を直す前後の逐語（決定4）。
- 【実測】変異試験3本——(1) `docs/README.md` に「17個」と書き戻す、(2) `docs/vision.md` に
  同じ形の1文を挿入する、(3) 両方で既存の歯（`runtime-method-doc-correspondence.test.mjs`）が
  巻き込まれず緑のままであることの確認。すべて `cp` で退避・復元し、`diff` で復元後の一致と、
  同じ7 tests が全緑に戻ることを確認した。
- 【実測】`pnpm exec eslint scripts/__tests__/runtime-method-count-not-baked.test.mjs`
  （警告0）。
- 【実測】`pnpm exec prettier --check scripts/__tests__/runtime-method-count-not-baked.test.mjs
docs/README.md`（新ファイルは成功、`docs/README.md` は警告）。
- 【実測】`git stash` で本 PR の変更を一時的に外した状態でも `docs/README.md` が
  `prettier --check` で同じ警告を出すことを確認した——本 PR が持ち込んだ失敗ではない。
- 【実測】`pnpm exec vitest run scripts/`（85 test files / 1520 tests、全緑）——
  scripts 配下の既存テスト全体への巻き込みが無いことの確認。
- 【実測】`node scripts/adr-renumber.mjs --next` → `0270`（本 ADR の仮番号。マージ直前に
  マネージャー側で確定し直される前提、ADR 0179）。

### 確かめていないこと

- ⛔ **ルートの `pnpm run test`（全体、typecheck/lint/format/build を含むフルスイート）は
  走らせていない**——`docs/autonomy.md` §2 により、手元での全体テストはマージの前提ではなく
  （ADR 0195）、CI が最終判定である。本 ADR の変更が触れたのは `scripts/__tests__/` の
  テストファイル1本（新規）と `docs/README.md`・本 ADR のみであり、`packages/` の
  ビルド・型・他パッケージのテストには触れていない。
- ⛔ **`packages/postgres` の DB テスト・実 API を通した経路は確認していない**——
  本 ADR の変更は文書1本・歯1本・ADR 1本のみであり、DB・LLM・embedding のいずれにも
  触れていない。
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーのとおり、これはクローンの判定である）。
- ⛔ **[Issue #606](https://github.com/takecchi/mnemora/issues/606) が引き受けた、生きた文書の
  数の焼き込みの一般形の掃引（漢数字・「N つ」を含む）は行っていない**——本 ADR は
  ADR 0269 が見つけた1つの実例だけを対象にしている（「⛔ この歯が捕まえないもの」2番）。
- ⛔ **正規表現 `[0-9]+個の(?:メソッド|口)` が将来の文書の書き方の変化にも狭いままかは、
  今回の実測時点（`f572676`）でしか確かめていない。**
