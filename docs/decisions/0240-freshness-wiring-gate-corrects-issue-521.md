# ADR 0240: Issue #521「時間項への検出力ゼロ」を訂正する — 穴は計算式ではなく `freshness` の配線だった。`total` への配線を守る歯を1本足す（`decay` の配線は範囲外）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-18

**⚠ 各主張の出所を分ける**（ADR 0226 / 0227 / 0233 / 0236 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を、作業者が自分で読んで確かめた。
- **【受】** — この作業を委譲した側（マネージャー）から、事前に実測した結果として渡された。
  **この PR の作業者自身は、その節の実測を再導出していない**（一部は独立に再現できたので、
  その旨を明記する）。

---

## 文脈

Issue #521 は、Issue #497（PR #509、ADR 0227）が着地させた
`examples/chat/src/__tests__/retrieval-quality-regression.postgres.test.ts` について、
ADR 0227 自身の逐語:

> ⟹ `decay`/`freshness` の計算式が丸ごと壊れて別の値（負の値・`NaN`・常に0など）を
> 返すようになっても、全候補が同じように壊れる限り相対順位は変わらず、この歯は
> 検出できない。

を根拠に、「**時間項への回帰検出力が構造的に0**」という問題提起を立てた。

**この問題の記述は不正確だった**——実測の結果、それが本 ADR の出発点である。

## 訂正: 「検出力ゼロ」ではなく「計算式は守られているが配線に穴がある」

### 変異表【受】——マネージャーが事前に実測し、この作業へ委譲文として渡した数字

`packages/core/src/strategies/scoring.ts` の既定スコア戦略に3種類の変異を別々に入れて
測った結果:

| 変異 | `@mnemora/core`（変異時点で61 files / 890 tests） | `@mnemora/postgres test:db`（55 files / 584 tests） |
|---|---|---|
| **1. `freshness` の計算式を殺す**（常に1を返す） | `scoring.test.ts` の**5件**が赤 | **全緑**（検出0） |
| **2. `decay` の計算式を殺す**（常に1を返す） | `scoring.test.ts` の**11件**が赤 | **全緑**（検出0） |
| **3a. 計算式は正しいまま `freshness` を `total` の積から外す**（＝配線を切る） | 🔴 **890件すべて緑。1件も検出しない** | 未測 |
| **3b. 同じく `decay` を `total` の積から外す** | `scoring.test.ts` の1件だけ偶然赤（`total` を直接単発比較しているケース。順位を見る歯ではない） | 未測 |

**陽性対照【受】**: ビルド済みの `defaultScoringStrategy` を直接呼び、2候補
（A: `occurredAt = now`、B: `occurredAt = 400日前`、他の項は同一）を比べたところ:

- 無変異: `A.total = 0.5`、`B.total ≈ 1.94e-121`（A が圧倒）
- 変異3a 適用後: **`A.total === B.total === 0.5`（完全同値）。** ただし
  `score.freshness` フィールド自体は正しい値のまま。

⟹ **「400日古びた記憶と、たった今の記憶が完全に同順位になる」という壊れ方が
実際に起きているのに、890件のテストは1件も検出しない。** 変異が効いていないことに
よる偽陰性ではない。

### 【実測】この作業者が独立に再現できた部分

上記の数字そのものは委譲文として受け取ったものであり、この作業者が
`@mnemora/postgres` 側や変異2・3bを再実測してはいない。ただし、本 PR の
「変異試験」節（後述）で行った作業の中で、**変異1と変異3aについては
独立に同種の現象を確認している**:

- **変異3a 相当**（`total` の積から `freshness` を外す）を、この作業者が
  自分でスコア関数へ入れて `pnpm --filter @mnemora/core test` を走らせたところ、
  新設した本 PR の歯（後述）以外の**900件すべてが緑のままだった**（この作業者が
  ADR を書いた時点の `main` は61ファイル/890件から62ファイル/900件へ進んでいる
  ——本 PR の3件を含む差である）。⟹ 表の「890件すべて緑」という主張と同じ
  現象を、別の日・別の commit で独立に確認した。
- **変異1相当**（`freshness` の計算式を `1` の定数へ潰す）を同様に自分で入れて
  走らせたところ、`scoring.test.ts` の**ちょうど5件**が赤くなった
  （後述「変異試験」節に赤の内訳を貼ってある）。⟹ 委譲文の「5件」という数字と
  独立に一致した。

**⟹ 表の「変異1」「変異3a」の `@mnemora/core` 列は【受】から【実測（独立再現）】へ
格上げできる。** それ以外（変異2・3bの `@mnemora/core` 列、変異1〜3bすべての
`@mnemora/postgres` 列、陽性対照の `0.5` / `1.94e-121` という具体的な数値そのもの）は、
この作業者が再導出していない**【受】のまま**である——この作業者が独立に確認したのは
「occurredAt だけを変えた2候補が、配線切れの下で厳密に同値になる」という**現象**で
あって、上の**具体的な数値**（`0.5`、`1.94e-121`）ではない（この作業者が組んだ入力は
`tagMatch=1`・`similarity`/`lexicalMatch` 無しの中立構成であり、`total` は無変異で
`1`、変異3a後も `1` になる——値は違うが現象は同じ）。

### ⟹ 結論

- **時間項の「計算式」は、すでに `scoring.test.ts` が守っている。** ADR 0227 の
  逐語「…**この歯は**検出できない」は正しい——だが、それを「repo に検出手段が
  無い」と読んだのは Issue #521 の飛躍だった。
- 🔴 **本当の穴は「計算式と順位の間の配線」である。** `freshness` が正しく
  計算されても、それが `total` の積に合成されなければ誰も気づかない。

**⛔ ADR 0227 の本文は書き換えていない。**1バイトも触っていない——当時の記録として
保つ（`docs/decisions/README.md` の規律）。ADR 0227 自身の文は「この歯は」と主語を
限定しており、誤ってはいない。誤っていたのは、その一文を「repo 全体に検出手段が
無い」へ広げた Issue #521 の読みのほうである。

## 決めたこと

### 決定1: `freshness` の「配線」を守る単体試験を1本足す

`packages/core/src/__tests__/scoring-freshness-wiring.test.ts` を新設した（既存の
`scoring.test.ts` には**足さない**——「計算式」を読む歯と「配線」を読む歯を、
ファイルの時点で読み手が区別できるようにするため）。

`defaultScoringStrategy`（`@mnemora/core` の公開経路 `export * from "./strategies/scoring.js"`
経由で取れる）を直接呼ぶ純粋な単体試験。DB もカセットも LLM も使わない。3本の `it`:

1. **本題**: `occurredAt` だけが違う2候補（`recordedAt`/`lastReinforcedAt`/`strength`/
   `tagMatch`/`similarity`/`now` はすべて同一）で、新しいほうの `total` が厳密に
   大きいことを検査する。`freshness` が `total` に合成されていなければこの検査は落ちる。
2. **計算式と配線を分ける**: 同じ2候補について、`score.freshness` の値自体も
   異なることを別途検査する。⟹ 「`freshness` は計算されているのに `total` に
   効いていない」（配線切れ）と「`freshness` の計算自体が壊れた」（計算式の穴、
   `scoring.test.ts` の管轄）を、**赤くなる `it` の違いで読み分けられる**ようにした。
3. **陰性対照**: `occurredAt` が同一の2候補では `total` が等しいことを検査する。
   ⟹ 何にでも差を主張する壊れた検査ではないことの裏付け。

**この歯の `describe`/`it` の名前自体に、示すもの・示さないものを書き込んである**
（vitest の出力は名前しか見せないため）。

### 決定2: `decay` の配線は本 PR の範囲に入れない（オーナーの判断【受】）

理由は3つ、いずれも委譲文として受け取ったもの:

(a) `decay` を DB 経路で散らすには活動時計（ADR 0165）が要り、Issue #338 と
    範囲が触れる。
(b) 階段状の `Clock` は Issue #497 の担い手が踏んだ「`fixedClock` を過去にすると
    embed ジョブが静かに claim されない」穴（ADR 0227「現物と食い違った点」節）の隣にある。
(c) 0 から 1 への前進をまず取り、範囲を絞る。

⚠ **正直に書く**: **この単体試験の層では (a)(b) は当たらない。** 本 PR の歯は
`recall()` も DB も呼ばない純粋な単体試験であり、`decay` の起点
（`lastReinforcedAt ?? recordedAt`）を変えるだけで、`occurredAt` を変えたのと
まったく同じ形——同じファイル・同じ3本立て（本題／計算式と配線の分離／陰性対照）
——で `decay` の配線も守れる。DB も活動時計も要らない。**⟹ `decay` の配線を
同じ形で守るのは安い。** それでも本 PR に入れないのは、**オーナーが範囲を
「まず freshness だけ」と切ったからであり、技術的な障害があるからではない。**

### 決定3: `packages/postgres` 側の変異3を本 PR では再測しない

上の変異表の `@mnemora/postgres test:db` 列（変異1・2で「全緑＝検出0」）は
委譲文としてそのまま受け取っており、この PR は `packages/postgres` に対して
何も変更していない。DB 経路での回帰検出力は本 PR の範囲外——決定2と同じ理由
（オーナーが範囲を「単体試験1本」に切った）。

## 副産物 —— 次に来る人のための地図

⭐ **`occurredAt` は抽出プロンプトにも埋め込み入力にも乗らないため、`recorded`
provider のカセットの鍵（入力文字列の SHA-256）に影響しない**
【受：別の作業者が実測し、`extraction.ts` の抽出プロンプト組み立てと DB 直クエリで
確認したものとして委譲文に含まれていた。この作業者は再導出していない】。

⟹ **鍵なしで「occurredAt をずらす」実験ができる**——`examples/chat` のような
`recorded` 経路の bench に時間差のある固定ケースを足すとき、`occurredAt` を
変えるだけなら記録の録り直しが要らない、という意味である。

🔴 **射程を正確に書く**: これは**`occurredAt` が鍵に影響しない**という意味で
あって、「時刻を変える実験なら何でも鍵が要らない」ではない。`digest` や質問文
（`messages[0].content`）を変える実験は、ADR 0236 が既に確認した通り鍵が変わる
——`packages/testkit/src/__fixtures__/cassette.ts` の `llmCassetteKey`/埋め込み側の
鍵は `{system, messages}`/入力文字列のハッシュであり、`occurredAt` はそのどちらにも
現れない、という**別の理由**による別の性質である。両者を混同しないこと。

## 変異試験（【実測】、`docs/autonomy.md` の作法に従う）

`cp` で退避 → 変異を入れる → 赤を確認 → `cp` で復元 → `git status --porcelain` が
空になることを確認 → 緑に戻ることを確認、という手順で行った（`git checkout` は
一度も使っていない）。

### 1. 現行 `main` で新しい歯が緑であること

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/scoring-freshness-wiring.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

### 2. `freshness` を `total` から外す変異（配線切れ）で、新しい歯が赤くなること

`packages/core/src/strategies/scoring.ts` の

```ts
const total = affinity * decay * tagMatch * freshness * input.strength;
```

を

```ts
const total = affinity * decay * tagMatch * input.strength;
```

へ変異させたところ:

```
FAIL  src/__tests__/scoring-freshness-wiring.test.ts
  × 本題: occurredAt だけが違う2候補で、新しいほうの total が厳密に大きい
    AssertionError: expected 1 to be greater than 1
 Test Files  1 failed | 1 passed (2)   ← scoring.test.ts は26件全緑のまま
      Tests  1 failed | 26 passed (27)
```

**「本題」だけが赤くなり、「計算式と配線を分ける」（`score.freshness` を見るほう）は
緑のままだった**——`freshness` は正しく計算されているが `total` に効いていない、
という配線切れの壊れ方を、赤くなった `it` が正確に指している。**同時に
`scoring.test.ts` の26件は1件も検出しない**——Issue #521 が問題にした穴を、
この歯が独立に再現した。

### 3. その変異を戻すと緑に戻ること

```
$ cp /tmp/scoring.ts.orig packages/core/src/strategies/scoring.ts
$ diff /tmp/scoring.ts.orig packages/core/src/strategies/scoring.ts   # 差分なし
$ git status --porcelain                                              # 新設ファイルのみ
$ pnpm --filter @mnemora/core exec vitest run \
    src/__tests__/scoring-freshness-wiring.test.ts src/__tests__/scoring.test.ts
 Test Files  2 passed (2)
      Tests  27 passed (27)
```

### 4. ⭐ 赤くなった理由が「配線が切れたから」だと読めること — 計算式を殺す変異との対比

`freshness` の**計算式そのもの**を殺す変異（`Math.min(...)` の式全体を `const freshness = 1;` へ置換）を別途入れたところ:

```
FAIL  src/__tests__/scoring-freshness-wiring.test.ts
  × 本題: occurredAt だけが違う2候補で、新しいほうの total が厳密に大きい
  × 計算式と配線を分ける: 同じ2候補で score.freshness 自体も異なる   ← ここが今回は赤い
FAIL  src/__tests__/scoring.test.ts
  × freshness は occurredAt を優先し、古い occurredAt ほど低くなる
  × freshness は occurredAt を起点にする（lastReinforcedAt にも recordedAt にも寄らない）
  × 過去の occurredAt は1ミリも動かない（上限を入れる前に実測した値そのもの）
  × occurredAt === now ちょうどでも 1（境界で1つずれていないこと）
  × occurredAt が無い記憶（いまのリポジトリの全件）では、上限に当たらず何も変わらない
 Test Files  2 failed (2)
      Tests  7 failed | 20 passed (27)
```

`scoring.test.ts` 側の赤の件数（**5件**）は、委譲文の変異表「変異1」の数字と一致した
（上記「独立に再現できた部分」節）。**⟹ 2つの壊れ方は、異なる `it` の組み合わせで
はっきり読み分けられる**:

| 壊れ方 | 「本題」 | 「計算式と配線を分ける」 | `scoring.test.ts` |
|---|---|---|---|
| 配線切れ（`total` から外す） | 🔴 赤 | 🟢 緑 | 🟢 全緑（検出0） |
| 計算式が壊れる（`freshness` を定数化） | 🔴 赤 | 🔴 赤 | 🔴 5件赤 |

その後 `cp` で復元し、`diff` が差分無し・`git status --porcelain` が新設ファイル
1件のみであることを確認し、`pnpm --filter @mnemora/core test` で**62ファイル・
900件すべて緑**に戻ることを確認した。

## 検証

```
$ pnpm --filter @mnemora/core test
 Test Files  62 passed (62)
      Tests  900 passed (900)

$ pnpm --filter @mnemora/core run typecheck   # tsc -p tsconfig.json、エラーなし

$ pnpm run lint       # eslint .、エラーなし
$ pnpm run format:check
Checking formatting...
All matched files use Prettier code style!
```

**`pnpm run test`（ルート全体）は走らせていない**——この作業環境で走らせないよう
明示的に指示されている（ルート全体はこの器では止まる）。`packages/postgres` の
DB 検査もこの PR の範囲外（決定3）につき走らせていない。

## 証明する範囲

- ⭕ **示すもの**: `freshness` が「順位へ配線されている」こと——計算されている
  だけでなく `total` の積に合成されていること。`occurredAt` だけを変えた2候補間で
  `total` に厳密な差がつくことを、`defaultScoringStrategy` を直接呼んで検査する。
- ⛔ **示さないもの**（本ファイルの `describe`/`it` の名前自体にも明記済み）:
  - **`freshness` の計算式そのものの正しさ**（`occurredAt` を優先するか・式の形が
    正しいか）——それは `scoring.test.ts` の管轄。
  - **`decay` の配線**——決定2により本 PR の範囲外。
  - **`recall()` から先の経路**——この歯はスコア戦略1つを直接呼んでいるだけで、
    `recall()` が実際に `total` で候補を並べ替えていることは検査していない。

## 採らなかった案

1. **`scoring.test.ts` に `it` を足す。** 却下——「計算式」と「配線」を読む歯を
   物理的に分けないと、どちらが赤くなったかで壊れ方を読み分けられる、という
   本 PR の値打ちの半分が消える。
2. **`decay` の配線も同じ PR で守る。** 却下（決定2）——オーナーが範囲を
   「まず freshness だけ」と切った。技術的な障害は無い（同じ形で安く守れる）ため、
   次に来る人がそのまま同じパターンを複製できるよう、決定2に明記した。
3. **`recall()` 経由（DB込み）の回帰試験にする。** 却下——ADR 0224 §2.2 が
   求める「必要な記憶や情報を落とす変異で赤、復元後に緑」の最小構成として、
   スコア戦略単体を直接呼ぶ形のほうが速く・決定的で、DB を要さない。`recall()`
   から先の配線（並べ替えそのもの）を守る歯は、別の PR の対象として残す
   （下記「確かめていないこと」）。

## 確かめていないこと

- **`recall()` が実際に `total` で候補を並べ替えていること。** 本 PR の歯は
  `defaultScoringStrategy` を直接呼ぶだけで、`recall-runtime.ts` がその出力を
  どう使うかは検査していない。
- **`decay` の配線。** 決定2により本 PR の範囲外。次の担い手は、本ファイルと
  同じ3本立て（本題／計算式と配線の分離／陰性対照）を `lastReinforcedAt` の
  差分に対して複製すれば、DB も活動時計も要らずに同じ形で守れる（決定2の
  「正直に書く」節）。
- **`packages/postgres` 側で変異1〜3bを走らせた場合の結果。** 変異表の
  `@mnemora/postgres test:db` 列は委譲文のまま——この作業者は再実測していない。
- **陽性対照の具体的な数値**（`A.total = 0.5`、`B.total ≈ 1.94e-121`）そのもの。
  この作業者が独立に確認したのは同種の現象（配線切れ下での完全同値化）であり、
  この数値自体ではない。

## これが覆るとしたら

- **`decay` の配線を守る歯が別 PR で足されたとき。** そのとき、決定2が指摘した
  「同じ形で安く守れる」という主張が、実際にどれだけ安かったかで検証される。
- **`recall()` から先の並べ替えを守る歯が足されたとき。** 本 ADR が明示した
  「確かめていないこと」の1つが埋まる。

## 引き受けた負債

**`decay` の配線は未検査のまま残る。** Issue #521 の完了条件は「`decay`/`freshness`
の計算式を壊す変異で赤、復元して緑」を求めていたが、本 PR は `freshness` の
「配線」だけを守り、`decay` の配線・計算式側の再検査（`scoring.test.ts` が既に
持っている）のいずれについても新規の作業は行っていない。**⟹ Issue #521 は
閉じない**（`Refs #521` — 穴の記述の訂正が残るため、閉じるかどうかはオーナーが
決める）。

## 人から受け取った前提（出所付き）

- 変異表・陽性対照の数値・`decay` を範囲外にする理由(a)(b)(c)・`occurredAt` が
  カセット鍵に影響しないという分析は、この作業を委譲した側からの委譲文として
  受け取った。**変異1・変異3a については、この作業者が独立に別の入力構成で
  再現し一致を確認した**（上記「独立に再現できた部分」節・「変異試験」節）。
  それ以外（変異2・3b、`@mnemora/postgres` 列、具体的な数値そのもの）は
  再導出していない。
- ADR 0226 / 0227 / 0233 / 0236 の内容——`docs/decisions/` から直接読んだ【現物】。
- Issue #521 の本文——`gh api repos/takecchi/mnemora/issues/521` で直接読んだ【現物】。
- `packages/core/src/strategies/scoring.ts` / `packages/core/src/__tests__/scoring.test.ts`
  / `packages/core/src/index.ts` の現状——この作業者が実際に読んで確認した【現物】。
- **DB を要する検査**（`packages/postgres`・`examples/chat` の `*.postgres.test.ts`）
  は、決定3により本 PR の範囲外につき実行していない。
