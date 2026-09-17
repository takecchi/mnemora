# ADR 0240: Issue #521「時間項への検出力ゼロ」を訂正する — 穴は計算式ではなく `freshness`/`decay` の配線だった。`total` への配線を守る歯を1本足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-18（`decay` を範囲へ足した訂正を同日中に追記）

⚠ **この ADR は本 PR（#529）がまだ着地していない間に、オーナーの範囲判断の訂正を
受けて書き足された。**`docs/decisions/README.md` の「採用済み ADR の本文は書き換えない」
という規律は**着地済みの ADR**に掛かるものであり、本 ADR はその対象ではない
（マネージャーからの明示的な確認）。ADR 0227 のような既に着地した ADR は、この PR でも
1バイトも変更していない。

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

### 【実測】追記 — `decay` 側（変異2・3b）も、この作業者が独立に再現し一致した

オーナーが範囲判断を訂正した後、この作業者は変異2（`decay` の計算式を殺す）と
変異3b（`decay` を `total` の積から外す）を、`@mnemora/core` に対して自分の手で
実際に走らせた（下記「変異試験」節に手順と生出力を貼ってある）:

- **変異3b 相当**（`total` の積から `decay` を外す）: `scoring.test.ts` の
  **ちょうど1件**だけが赤くなった（`上限を掛けたのは freshness だけで、decay には
  掛けていない` — `total` を直接単発比較しているケース）。委譲文の「1件だけ偶然赤」
  という記述と**独立に一致した**。
- **変異2相当**（`decay` の計算式を `1` の定数へ潰す）: `scoring.test.ts` の
  **ちょうど11件**が赤くなった。委譲文の「11件」という数字と**独立に一致した**。

**⟹ 表の「変異2」「変異3b」の `@mnemora/core` 列も、【受】から【実測（独立再現）】へ
格上げする。** 残る【受】のままの部分は、`@mnemora/postgres test:db` 列（4変異とも
未測のまま）と、陽性対照の具体的数値（`0.5`/`1.94e-121`）のみである。

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
経由で取れる）を直接呼ぶ純粋な単体試験。DB もカセットも LLM も使わない。`freshness` を
守る `describe` に3本の `it`:

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

### 決定2: `decay` の「配線」も同じファイル・同じ形で守る（訂正。当初は範囲外にしていた）

**この決定は訂正を経ている。**当初この PR は `decay` の配線を範囲外にしていた
（下の「経緯——訂正の記録」節に、当時の理由と、それがどう崩れたかをそのまま残す）。
**オーナーが範囲判断を訂正し、同じ PR に `decay` 側も足すよう指示した。**

⟹ 同じファイル（`scoring-freshness-wiring.test.ts`）に、`decay` を守る2つ目の
`describe` を足した。`freshness` の3本立てをそのまま複製し、変える軸だけを
`occurredAt` → `lastReinforcedAt` に差し替えた:

1. **本題**: `lastReinforcedAt` だけが違う2候補（他の項はすべて同一。`occurredAt`
   は両候補とも `null` に固定し、`freshness` 側を一切動かさない）で、新しいほうの
   `total` が厳密に大きいことを検査する。
2. **計算式と配線を分ける**: 同じ2候補について、`score.decay` の値自体も
   異なることを別途検査する。
3. **陰性対照**: `lastReinforcedAt` が同一の2候補では `total` が等しいことを検査する。

`freshness` 側と `decay` 側は起点が違う（`occurredAt ?? recordedAt` vs
`lastReinforcedAt ?? recordedAt`）ため、**片方の配線が壊れても、もう片方の
`describe` は緑のまま**——2つの項の配線切れを、`describe` の違いでも読み分けられる。

### 決定3: `packages/postgres` 側の変異1〜3bを本 PR では再測しない

上の変異表の `@mnemora/postgres test:db` 列（変異1・2で「全緑＝検出0」、変異3a・3b
未測）は委譲文としてそのまま受け取っており、この PR は `packages/postgres` に対して
何も変更していない。**この範囲判断（決定2とは異なり）は訂正されていない**——DB 経路
での回帰検出力は、`@mnemora/core` の単体試験1本という本 PR の形の外にある。

## 経緯——訂正の記録（当初 `decay` を範囲外にした理由と、それがどう崩れたか）

**この節は本 ADR がまだ着地する前に書き足された訂正であり、当初の判断を消さずに残す**
（`docs/decisions/README.md` の「間違え方それ自体が記録である」という考え方を、着地前の
自分自身の判断にも適用する）。

### 当初の判断（オーナーの判断として【受】、決定2の旧稿）

`decay` の配線を本 PR の範囲に入れない理由として、3つが委譲文として渡されていた:

(a) `decay` を DB 経路で散らすには活動時計（ADR 0165）が要り、Issue #338 と
    範囲が触れる。
(b) 階段状の `Clock` は Issue #497 の担い手が踏んだ「`fixedClock` を過去にすると
    embed ジョブが静かに claim されない」穴（ADR 0227「現物と食い違った点」節）の隣にある。
(c) 0 から 1 への前進をまず取り、範囲を絞る。

この作業者は当時、(a)(b) は単体試験の層には当たらないことを ADR に明記していた
（`lastReinforcedAt` を変えるだけで足り、活動時計も DB も #338 も要らない）——ただし
それでも「オーナーが範囲を切ったから」として範囲外のまま置いていた。

### 🔴 訂正——3つとも崩れた

オーナーが範囲判断を訂正した際の指摘、そのままここに残す:

1. **(a) は当たらない。** `lastReinforcedAt` を変えるだけで済み、活動時計も DB も
   Issue #338 も要らない——この作業者自身が当初の ADR に書いていたことと同じ結論
   である。
2. **(b) は当たらない。** 同じ理由（`recall()` も `Clock` の実装も呼ばない純粋な
   単体試験である）で、階段状の `Clock`・`fixedClock` の軸を使わずに済む。
3. **(c) は実際には「0→1」ではなく「1→2」だった。** `scoring.test.ts` が
   `decay` の計算式そのものは既に守っていた（変異2で11件が赤くなる、上の表）
   ——「まず前進を取る」という根拠は、時間項の検出力が本当に0だった場合ほど
   強くない。

**決め手になったのは検出力の実測である**: `decay` の配線切れ（変異3b）を検出できる
既存の歯は**1件だけ**であり、しかもそれは「`total` を直接単発比較しているだけの
偶然」であって、順位を見る歯ではない（上の変異表）。**⟹ `freshness` だけを守って
`decay` を空けたまま「時間項の配線を守った」と PR/ADR に書けば、その説明は半分しか
本当でなくなる。** 説明が事実と食い違ったまま着地することは、この repo が ADR 0068
（ベンチが測っていないことを測ったかのように印字しない）以来、繰り返し名指しで
直してきた欠陥そのものである。

⟹ **オーナーが範囲を訂正し、`decay` の配線も同じ PR（同じファイル）に足すことに
した。**上の決定2はこの訂正後の形である。

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

### 5. `decay` の配線を守る歯を追加後、main で緑であること

`decay` 側の3本（本題／計算式と配線の分離／陰性対照）を同じファイルへ足した後:

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/scoring-freshness-wiring.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### 6. `decay` を `total` から外す変異（配線切れ）で、`decay` 側の「本題」だけが赤くなること

```ts
const total = affinity * decay * tagMatch * freshness * input.strength;
```

を

```ts
const total = affinity * tagMatch * freshness * input.strength;
```

へ変異させたところ:

```
FAIL  src/__tests__/scoring-freshness-wiring.test.ts
  × 本題: lastReinforcedAt だけが違う2候補で、新しいほうの total が厳密に大きい
    AssertionError: expected 1 to be greater than 1
FAIL  src/__tests__/scoring.test.ts
  × 上限を掛けたのは freshness だけで、decay には掛けていない
 Test Files  2 failed (2)
      Tests  2 failed | 28 passed (30)
```

**`decay` 側の「本題」だけが赤くなり、`freshness` 側の3本（本題・計算式と配線の分離・
陰性対照）はすべて緑のままだった**——2つの項の配線切れが `describe` の違いで
読み分けられることを実測で確認した。`scoring.test.ts` 側は**ちょうど1件**だけ赤くなり
（`上限を掛けたのは freshness だけで、decay には掛けていない`——`total` を直接単発
比較しているケースが偶然拾った）、委譲文の「1件だけ偶然赤」という記述と独立に一致した。

その後 `cp` で復元し、`diff` 差分なし・`git status --porcelain` が新設ファイルの
編集のみであることを確認し、`pnpm --filter @mnemora/core exec vitest run
src/__tests__/scoring-freshness-wiring.test.ts src/__tests__/scoring.test.ts` で
**30件すべて緑**に戻ることを確認した。

### 7. ⭐ `decay` の計算式そのものを殺す変異との対比

`computeDecay` の本体を `return 1;` に潰す変異を入れたところ:

```
FAIL  src/__tests__/scoring-freshness-wiring.test.ts
  × 本題: lastReinforcedAt だけが違う2候補で、新しいほうの total が厳密に大きい
  × ⭐ 計算式と配線を分ける: 同じ2候補で score.decay 自体も異なる   ← ここが今回は赤い
FAIL  src/__tests__/scoring.test.ts（11件）
  × 時間が経つほど decay は小さくなる（lastReinforcedAt 基準）
  × decay は lastReinforcedAt を起点にする（occurredAt にも寄らない）
  × 上限を掛けたのは freshness だけで、decay には掛けていない
  × decayClock 省略時は壁時計のみ——活動時計の入力があっても無視する
  × decayClock: 'wall' を明示しても同じ——活動時計の入力を無視する
  × decayClock: 'activity' で3つの入力が揃っていれば活動時計だけを使う（壁時計の値を無視する）
  × decayClock: 'activity' でも活動時計の入力が欠けていれば壁時計へフォールバックする（ADR 0165 決めたこと4と同じ向き）
  × decayClock: 'activity' でも decayBaseSeq が null（NULL＝この軸に床が無い）なら壁時計へフォールバックする
  × decayClock: 'either' は Math.max——活動時計のほうが大きい（生きている）とき活動時計を採る
  × decayClock: 'either' は Math.max——壁時計のほうが大きい（生きている）とき壁時計を採る
  × decayClock: 'either' でも活動時計の入力が欠けていれば壁時計の値だけになる（Math.max のもう片方が存在しないのと同じ）
 Test Files  2 failed (2)
      Tests  13 failed | 17 passed (30)
```

`scoring.test.ts` 側の赤の件数（**11件**）は、委譲文の変異表「変異2」の数字と
**独立に一致した**。`freshness` 側の3本はここでも緑のまま——2つの項が独立に
壊れ方を区別できることを、`decay` 側でも実測で確認した:

| 壊れ方 | `decay`「本題」 | `decay`「計算式と配線を分ける」 | `freshness` 側3本 | `scoring.test.ts` |
|---|---|---|---|---|
| `decay` 配線切れ（`total` から外す） | 🔴 赤 | 🟢 緑 | 🟢 緑のまま | 🔴 1件だけ赤 |
| `decay` 計算式が壊れる（`computeDecay` を定数化） | 🔴 赤 | 🔴 赤 | 🟢 緑のまま | 🔴 11件赤 |

その後 `cp` で復元し、`diff` が差分無し・`git status --porcelain` が新設ファイルの
編集のみであることを確認し、**30件すべて緑**に戻ることを確認した。

⚠ **変異後の `build` について**: `docs/autonomy.md` は「変異後は `pnpm --filter
@mnemora/core run build` が要ることがある」と注意しているが、上記6・7の変異試験は
いずれも `vitest run` を直接呼んでおり（`@mnemora/core` のビルド成果物を経由しない）、
`build` は不要だった——ソースへの変更が即座に反映される vitest の transform を
経由したためである。

## 検証

```
$ pnpm --filter @mnemora/core test
 Test Files  62 passed (62)
      Tests  903 passed (903)

$ pnpm --filter @mnemora/core run typecheck   # tsc -p tsconfig.json、エラーなし

$ pnpm run lint       # eslint .、エラーなし
$ pnpm run format:check
Checking formatting...
All matched files use Prettier code style!
```

（`decay` 側3本を足す前は900件だった。ファイル数は62のまま——同じ新設ファイルに
`describe` を1つ足しただけで、ファイルを増やしていない。）

**`pnpm run test`（ルート全体）は走らせていない**——この作業環境で走らせないよう
明示的に指示されている（ルート全体はこの器では止まる）。`packages/postgres` の
DB 検査もこの PR の範囲外（決定3）につき走らせていない。

## 証明する範囲

- ⭕ **示すもの**: `freshness` と `decay` の両方が「順位へ配線されている」こと
  ——計算されているだけでなく `total` の積に合成されていること。`occurredAt`
  だけ（または `lastReinforcedAt` だけ）が違う2候補間で `total` に厳密な差が
  つくことを、`defaultScoringStrategy` を直接呼んで検査する。
- ⛔ **示さないもの**（本ファイルの `describe`/`it` の名前自体にも明記済み）:
  - **`freshness`/`decay` の計算式そのものの正しさ**（`occurredAt`/
    `lastReinforcedAt` を優先するか・式の形が正しいか）——それは
    `scoring.test.ts` の管轄。
  - **`recall()` から先の経路**——この歯はスコア戦略1つを直接呼んでいるだけで、
    `recall()` が実際に `total` で候補を並べ替えていることは検査していない。
    SQL 側で `decay`/`freshness` 相当の項が別途落ちていないかも見ていない。
  - **`tagMatch`・`similarity`・`lexicalMatch`・`strength` の配線。** 本 PR が
    守るのは時間項（`freshness`/`decay`）の2項だけである——他の3項についても
    同種の配線切れが理論上ありうるが、この歯は検査していない。

## 採らなかった案

1. **`scoring.test.ts` に `it` を足す。** 却下——「計算式」と「配線」を読む歯を
   物理的に分けないと、どちらが赤くなったかで壊れ方を読み分けられる、という
   本 PR の値打ちの半分が消える。
2. **`decay` の配線を別 PR に分ける。** 却下——オーナーが範囲判断を訂正した
   経緯（上記「経緯——訂正の記録」節）により、`freshness` だけを守ると
   「時間項の配線を守った」という説明が事実と半分食い違う。同じ PR・同じ
   ファイルに両方を入れることで、説明と実装を一致させた。
3. **`recall()` 経由（DB込み）の回帰試験にする。** 却下——ADR 0224 §2.2 が
   求める「必要な記憶や情報を落とす変異で赤、復元後に緑」の最小構成として、
   スコア戦略単体を直接呼ぶ形のほうが速く・決定的で、DB を要さない。`recall()`
   から先の配線（並べ替えそのもの）を守る歯は、別の PR の対象として残す
   （下記「確かめていないこと」）。

## 確かめていないこと

- **`recall()` が実際に `total` で候補を並べ替えていること。** 本 PR の歯は
  `defaultScoringStrategy` を直接呼ぶだけで、`recall-runtime.ts` がその出力を
  どう使うかは検査していない。
- **`packages/postgres` 側で変異1〜3bを走らせた場合の結果。** 変異表の
  `@mnemora/postgres test:db` 列は委譲文のまま——この作業者は再実測していない
  （決定3、範囲外のまま訂正されていない）。
- **陽性対照の具体的な数値**（`A.total = 0.5`、`B.total ≈ 1.94e-121`）そのもの。
  この作業者が独立に確認したのは同種の現象（配線切れ下での完全同値化）であり、
  この数値自体ではない。
- **`tagMatch`・`similarity`・`lexicalMatch`・`strength` の配線。** 本 PR の
  範囲外——時間項（`freshness`/`decay`）の2項だけを対象にしている。

## これが覆るとしたら

- **`recall()` から先の並べ替えを守る歯が足されたとき。** 本 ADR が明示した
  「確かめていないこと」の1つが埋まる。
- **`packages/postgres` 側で変異1〜3bを走らせる検査が別 PR で足されたとき。**
  決定3が範囲外に置いた DB 経路の検出力が実測される。
- **`tagMatch`・`similarity`・`lexicalMatch`・`strength` の配線を守る歯が
  足されたとき。** 本 PR が時間項2つだけに絞った理由（他項の配線切れは
  未検査のまま）が埋まる。

## 引き受けた負債

**`freshness`/`decay` の「配線」は本 PR で守られたが、次の3つは未検査のまま残る**:

1. **`recall()` から先の経路。** `total` で実際に並べ替えているか、SQL 側で
   同種の項が落ちていないかは未検査。
2. **`packages/postgres test:db` 側の変異1〜3b。** 決定3により本 PR の範囲外。
3. **`tagMatch`・`similarity`・`lexicalMatch`・`strength` の配線。** 時間項
   以外の3項についても理論上は同種の配線切れがありうるが、本 PR は検査していない。

Issue #521 の完了条件は「`decay`/`freshness` の計算式を壊す変異で赤、復元して緑」
だったが、本 PR は**計算式ではなく配線**を守るものである（計算式は既に
`scoring.test.ts` が守っている、というのが本 ADR の中心の訂正）。**⟹ Issue #521
は閉じない**（`Refs #521` — 穴の記述の訂正が残るため、閉じるかどうかはオーナーが
決める）。

## 人から受け取った前提（出所付き）

- 変異表・陽性対照の数値・`occurredAt` がカセット鍵に影響しないという分析は、
  この作業を委譲した側からの委譲文として受け取った。**変異1・2・3a・3bすべてに
  ついて、この作業者が独立に別の入力構成で再現し一致を確認した**（上記
  「独立に再現できた部分」節・「`decay` 側も…一致した」節・「変異試験」節）。
  それ以外（`@mnemora/postgres` 列、陽性対照の具体的な数値そのもの）は
  再導出していない。
- `decay` を当初範囲外にした理由(a)(b)(c)と、それを訂正した経緯・決め手
  （検出できる既存の歯が1件だけだったこと、「0→1」ではなく「1→2」だったこと）
  は、この作業を委譲した側からの委譲文としてそのまま受け取り、上記
  「経緯——訂正の記録」節に残した。
- ADR 0226 / 0227 / 0233 / 0236 の内容——`docs/decisions/` から直接読んだ【現物】。
- Issue #521 の本文——`gh api repos/takecchi/mnemora/issues/521` で直接読んだ【現物】。
- `packages/core/src/strategies/scoring.ts` / `packages/core/src/__tests__/scoring.test.ts`
  / `packages/core/src/index.ts` の現状——この作業者が実際に読んで確認した【現物】。
- **DB を要する検査**（`packages/postgres`・`examples/chat` の `*.postgres.test.ts`）
  は、決定3により本 PR の範囲外につき実行していない。
