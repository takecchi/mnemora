# ADR 0254: 偽陽性率に上限を置けない検査は門にしない — ADR 0223 決定3 の射程を `AGENTS.md` へ広げる。🔴 ただし線は引けない（Issue #505）

- **状態**: 採用 (2026-09-21)
- **日付**: 2026-09-21

> **⚠ この ADR を書いたのは、担い手（自動化されたエージェント）である。⛔ オーナー本人の判断ではない。**
> **判断そのものは、クローン miku（自動化された担い手）による [Issue #505](https://github.com/takecchi/mnemora/issues/505) の
> 判定コメント（[issuecomment-5714613359](https://github.com/takecchi/mnemora/issues/505#issuecomment-5714613359)）に
> 先に置かれている。**同コメント自身が冒頭で「クローン miku（自動化された担い手）による判定である。
> ⛔ オーナー本人の判定ではない」と名乗っている。**この ADR が足すのは、その判断を記録の形にすることと、
> 現物 ADR への当て直し、および ADR 0223 の逐語自体の現物での位置の確認である。**
> ⚠ **投稿者名・commit の署名からは、オーナー本人と担い手を見分けられない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 / 0199 / 0200 / 0211 / 0212 / 0234 / 0250 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`vitest`/`gh` 等を走らせて確かめた。
- **【受】** — 依頼元（マネージャー）または Issue コメントからの報告として受け取り、再導出していない。

---

## 文脈

**[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) は、ADR 211本の母集合から
「繰り返し採られているのに入口の文書に書かれていない規律」を10本抽出した。**その決定3 がこれである
【現物・逐語】:

> **一般形**: **門（落とす検査）にしてよいのは、偽陽性率に上限を置けると実測できたものだけである。
> 置けないなら門にしない。**⟹ **その代わりに置いたもの（観測口・警告・候補一覧・人手監査）を、
> 同じ場所に明記する。**

**⛔ そして ADR 0223 は、成文化の場所を自分では決めなかった**【現物・逐語、「⛔ 成文化の場所 ——
**未決のまま残す**」節】:

> **どこへ置くかで読者が変わる。**`AGENTS.md` は人もエージェントも読む。`docs/autonomy.md` は
> 「オーナーに逐一確認せずに進める担い手」向けだと自ら宣言している。⟹ **決定2・3・5・9 は
> *道具を作る側* への規律であり、そのどちらの宛先とも一致しない。**⭐ **3本目の宛先が要るのかどうかも、
> この ADR は決めない。**

**その未決を [Issue #505](https://github.com/takecchi/mnemora/issues/505) が引き取り、6つの決定
（2/3/5/6/9/10）を1本ずつ判断することにした。**決定9 は [ADR 0234](./0234-bake-no-numbers-into-tools-and-artifacts.md)
（[PR #520](https://github.com/takecchi/mnemora/pull/520)）が、決定2 は
[ADR 0250](./0250-machines-detect-humans-confirm-and-write.md)（[PR #553](https://github.com/takecchi/mnemora/pull/553)）
が既に答えている。**この ADR は、残る決定3 だけに答える。**⚠ **決定5・6・10 は、別の担い手が同時に別ブランチで
判断している。この ADR は1バイトも触っていない。**

**【受】この ADR の判断そのものは Issue #505 のコメントに先に置かれている**（逐語「## 2. 決定3 —
✅ **yes。ただし 🔴 線は引けない。「引けない」と名乗って書くこと**」）。⟹ **この ADR が足すのは、
その判断を現物へ当て直し、記録の形にすることである。**

---

## ⭐ なぜ入口へ置くのか — 入口に在るのは「設計案を選ぶ問い」であって「機械の門」ではない

**【現物】`docs/north-star.md` には、近い形が既に在る。⛔ ただし対象が違う。⚠ そして
2つの逐語は、Issue #505 のコメントが読めるような形で同じ節に連続して在るのではない。**

🔴 **マネージャーからの訂正を受け、書き手自身が `grep -n` と通読で当て直した**【実測】:

| 逐語 | 在る節（`docs/north-star.md`） |
|---|---|
| 「**この問いは、実際に設計案を落とすためにある。**どの案も落とせない問いは、書き直すか捨てる。」 | **「迷ったときの問い」節**（冒頭） |
| 「**落としすぎる問いは、落とせない問いと同じくらい役に立たない。**」 | 🔴 **「この問いが、実際に案を落とすことの確認」節**（別の H2 見出し。問い1 を書き直した経緯——「監査ログと provenance が落ちてしまった」——を説明する文脈の中に在る） |

⟹ ⚠ **[Issue #505 本文](https://github.com/takecchi/mnemora/issues/505) と
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3 は、
この2つの逐語を「…」で繋いで引用しており、読み方によっては同じ節に在るように見える。**
**⛔ 現物は別の節である。**⟹ **この ADR ではどちらの逐語も、それぞれの節名で引く**（[ADR 0213](./0213-live-docs-cite-adrs-by-anchor-not-line-number.md)
のとおり行番号では指さない）。

⚠ **この取り違えは、結論を変えない。**「迷ったときの問い」も「この問いが、実際に案を落とすことの確認」も、
**どちらも設計案（プロダクトの設計判断）を選ぶための問いについて書いており、CI に置く機械の検査
（歯・門）については、どちらの節も一言も触れていない。**⟹ ⛔ **機械の門についての版は、
`docs/north-star.md` のどこにも無い。**

**この形を独立に採った ADR の一覧は
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3 に在る**
（[ADR 0088](./0088-retrieval-quality-measured-in-ci.md) / [ADR 0094](./0094-identifier-probes-local-embedding.md) /
[ADR 0200](./0200-adr-renumber-warns-when-titles-need-fixing.md) /
[ADR 0214](./0214-release-candidates-lists-not-judges.md) /
[ADR 0216](./0216-north-star-shipped-only-measurement.md) の5本。ここには一覧を写さない——
下の「決めたこと」節、および ADR 0250/0234 と同じ理由）。

---

## 🔴 線は引けない — ADR 0178 が反例

**[ADR 0178](./0178-public-api-surface-gate.md) は、偽陽性が構造的に出ると分かったうえで、
それでも門にしている。**逐語（「引き受けた負債」2番）【現物】:

> **union のメンバー並び替えなど、意味的に無変化でも構文順序が変われば赤くなる。**
> TypeScript の printer は入力の構文順序をそのまま保持して出力するため、たとえば
> `"a" | "b"` を `"b" | "a"` に書き換えるだけの無害な変更でも diff に現れる。
> **偽陽性（false positive）を許容している——「変わったら必ず人に見せる」を
> 「意味的に無変化なものは自動で除外する」より優先した。**

⟹ **[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)（偽陽性率に上限を置けないので門にしない）と
[ADR 0178](./0178-public-api-surface-gate.md)（偽陽性を承知で門にする）は、同じ repo の中で
逆方向の判断をしている。**

🔴 **「偽陽性を人が解消する費用で割れる」とは書けない。** それは読みであって repo の記録ではない
【実測・陰性対照】: `grep -rn "費用" docs/decisions/0088-retrieval-quality-measured-in-ci.md
docs/decisions/0178-public-api-surface-gate.md` はどちらも「費用」という語自体を含まない
（0本ヒット）。**どちらの ADR も、割れる理由をその言葉で書いていない。**

⭐ **これは逃げではない。**[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定8 の反例節が、同じ形をすでに正当なものとして認めている【現物・逐語】:

> **「次の一手が決まらない」ときの選択肢は「足さない」だけではない。「いまは決めない」と名乗って
> 測れる形を先に置く、もある。**（[ADR 0046](./0046-contested-pair-invariant-tooth.md) の形）

⟹ 🔴 **書くべき形**（[Issue #505](https://github.com/takecchi/mnemora/issues/505) のコメントが指定した逐語）:

> **偽陽性率に上限を置けない検査は門にしない。⚠ ただし ADR 0178 は偽陽性を承知で門にしている。
> どちらに倒すかの線は、いまのところ書けていない —— 判断するときは両方の ADR を読むこと。**

---

## 測ったこと

- **【現物】[ADR 0088](./0088-retrieval-quality-measured-in-ci.md) を自分で開いた。**
  §2.1「⟹ **偽陽性率に上限を置けない。**」「⛔ **偽陽性率を上限で抑えられない門は、いずれ無視されるか
  無効化される。それは門が無いより悪い。**」の逐語が現物と一致することを確認した。
- **【現物】[ADR 0094](./0094-identifier-probes-local-embedding.md) を自分で開いた。**
  「門を置く条件は『標本が増えたこと』ではなく『**増えた母数で偽陽性率に上限を置けると測れたこと**』
  である」の逐語、および「**前半は満たした。後半は満たしていない。**2 run では偽陽性*率*に
  上限を置けない。⟹ **⛔ 門は置いていない。**」が現物と一致することを確認した。
- **【現物】[ADR 0200](./0200-adr-renumber-warns-when-titles-need-fixing.md) を自分で開いた。**
  「⟹ **15件中2件が紛れ、13件が正当な参照——偽陽性率 13/15 ≈ 86.7%**」の実測値と、
  それを理由に required にせず**警告**（人が読む）に留めたことを確認した
  （`grep -n "13/15" docs/decisions/0200-*.md` が該当行を返す）。
- **【現物】[ADR 0214](./0214-release-candidates-lists-not-judges.md) を自分で開いた。**
  「決定1: 作る。ただし ⛔ 判定ではなく『候補の一覧』として作る」「決定6: CI に配線しない。
  終了コードは常に 0」を確認した。
- **【現物】[ADR 0216](./0216-north-star-shipped-only-measurement.md) を自分で開いた。**
  「最初に作るなら、門ではなく『一覧を吐くだけ』にすること。…門にするかは、判定が落ち着いてから
  別に決める」の逐語を確認した。
- **【現物】[ADR 0178](./0178-public-api-surface-gate.md) の全文（317行）を通読した。**
  上の「線は引けない」節に引いた逐語が、「引き受けた負債」2番と一致することを確認した。
  同 ADR「これが覆るとしたら」節は、この歯自身が「偽陽性の頻度が高く、担当者が『どうせ赤くなる』と
  diff を読み飛ばす習慣ができてしまったとき」に切り替えを検討すると書いており、
  **ADR 0088 の懸念（無視される門は門が無いより悪い）を、ADR 0178 自身が将来の反転条件として
  引き受けている**ことを確認した。
- **【実測】`grep -rn "費用" docs/decisions/0088-retrieval-quality-measured-in-ci.md
  docs/decisions/0178-public-api-surface-gate.md`** — 0本ヒット。**陽性対照**として
  `grep -rn "偽陽性" docs/decisions/0088-retrieval-quality-measured-in-ci.md
  docs/decisions/0178-public-api-surface-gate.md` を同じコマンドの形で実行し、双方で複数ヒットする
  ことを確認した（`grep` 自体が生きていることの確認。0本という結果が「語がそもそも掛からない
  空振り」ではないことを示す）。
- **【実測】`docs/north-star.md` の該当2逐語の所在**を `grep -n` と通読で確認した
  （上の「なぜ入口へ置くのか」節の表）。マネージャーからの訂正指示を受けて自分で当て直した結果、
  訂正どおり2つは別の H2 節に在ることを確認した。
- **【現物】[ADR 0251](./0251-release-follow-up-notice-not-a-gate.md) と
  [ADR 0252](./0252-release-changelog-section-is-a-publish-gate.md) を、決定3 の個別適用として
  読めるか確かめた。**
  - **[ADR 0252](./0252-release-changelog-section-is-a-publish-gate.md) は明確に引ける。**
    同 ADR は自ら [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
    決定3 を名指しして引用し（「## 🔴 この門が ADR 0223 決定3 を自分で満たすことの根拠」節）、
    過去4リリースへ実際の道具を当てて**真陽性 4/4・偽陽性 0/4**を実測し、
    「偽陽性が出うる場面は、列挙できる」（`workflow_dispatch` の予行・`prerelease` の Release の
    2つに限られる）ことを上限の根拠にしている。**⭐ これは ADR 0178 の「費用が低いから許容する」
    とは異なる、もう1つの「上限を置ける」形——述語が内容を推定しないことで、偽陽性の出る場面を
    構造的に列挙できる——である。**ADR 0088/0094 の「実測して数える」形とも、ADR 0178 の
    「費用で許容する」形とも違う3つ目の根拠であり、**どちらの線の候補にもならず、決定3の一般形
    （置けると実測できたものだけを門にする）をそのまま満たす素直な適用例である。**
  - **[ADR 0251](./0251-release-follow-up-notice-not-a-gate.md) は弱い形でしか引けない。**
    同 ADR は「引き受けた負債」3番で「⚠ **偽陽性が出る形がある**——Release を publish した直後に
    節を書く運用なら、通知は毎回『🔴 節が無い』と出る」と書いているが、**この ADR が門にしなかった
    主な理由は偽陽性率ではなく「外したときに誰が巻き添えになるか」（require にした場合の
    ブラスト半径・可逆性）である**（同 ADR の題そのもの）。⟹ **決定3 の直接適用というより、
    決定3 と隣接する別の判断軸（巻き添え）の実例として引くのが正確である。この ADR では
    決定3 の個別適用として強く主張しない。**
- **【現物】[ADR 0250](./0250-machines-detect-humans-confirm-and-write.md) が、
  この ADR より先に、既に決定3 を自己適用していることを確認した**（逐語「⭐ 歯を足すか — ⛔ 足さない」節、
  理由1）:

  > 1. **偽陽性率に上限を置けるとは言えない**（[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
  >    決定3「⛔ **偽陽性率に上限を置けない検査は、門にしない**」への自己適用）。

  ⟹ **決定3 は、`AGENTS.md` に入る前から、この repo の判断のなかで既に引用され、使われている。**
  これは ADR 0234 決定9 の「入口に無いまま使われている」構図と同型である。
- **【実測】`ls docs/decisions/ | grep '^0254-'`** — 1件（この ADR 自身）。番号衝突無し。
- **【実測】`gh search issues --repo takecchi/mnemora "偽陽性率 上限 門"`** — [Issue #505](https://github.com/takecchi/mnemora/issues/505)
  自身のみヒット。**個別インスタンスの ISSUE は見つからない。**
  **陽性対照**: 同じコマンドの形で `gh search issues --repo takecchi/mnemora "ADR 0223"` を実行し、
  #505 / #518 / #567 / #403 / #515 / #512 / #521 / #153 / #499 / #152 の10件がヒットすることを
  確認した（検索そのものが機能していることの確認）。
- **【実測】`AGENTS.md` へ新設した見出し「### ⚠ 偽陽性率に上限を置けない検査は門にしない」を書いた後、
  `pnpm exec vitest run scripts/__tests__/adr-citation.test.mjs
  scripts/__tests__/local-embedding-size-noun-correspondence.test.mjs` を実行し、
  2ファイル・75 tests 全て green であることを確認した。**
- **【実測】変異試験。** `AGENTS.md` の新設節にある `[ADR 0178](./docs/decisions/0178-public-api-surface-gate.md)`
  を、意図的に行番号引用の形（`` `docs/decisions/0178-public-api-surface-gate.md:1` ``）へ書き換え、
  `pnpm exec vitest run scripts/__tests__/adr-citation.test.mjs` を実行したところ、
  「🔴 本物の歯1: 生きた文書に ADR への行番号引用が無いこと（実物）」の1 test が red になった
  （`AGENTS.md` の該当行を名指しして検出）。`cp` で退避しておいた元の `AGENTS.md` を `cp` で復元し
  （`git checkout` は使っていない）、`git status --porcelain` が `M AGENTS.md`（意図した差分のみ）に
  戻ったことを確認したうえで、同じ検査を再実行して75 tests 全て green に戻ることを確認した。
  ⟹ **この歯は、狙った箇所（新設節の ADR 引用）を実際に捕まえる。**

## 決めたこと

### 決定1. `AGENTS.md`「作業のときの決まり」に「⚠ 偽陽性率に上限を置けない検査は門にしない」を新設する

**[ADR 0250](./0250-machines-detect-humans-confirm-and-write.md) の決定2（`⚠ 機械には「検出」まで`）節の
直後、`## 名前について` の手前に置く。**⭐ **理由は ADR 0250 決定2 と同じ**——決定2・3 はどちらも
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) が「*道具を作る側* への規律」
として同じグループに分類しており（「⛔ 成文化の場所」節）、決定2 が「作業のときの決まり」に
自然に収まったのと同じ位置——**隣接する節として並べておくほうが、道具を作る側の規律という
まとまりが読み手に伝わる。**

**書くのは3つ**: (1) 一般形（偽陽性率に上限を置けると実測できたものだけを門にする。置けないなら
代わりに置いたものを明記する） (2) **入口に既に在る狭い版との違い**（設計案を選ぶ問いではなく
機械の門の話である） (3) **🔴 線が引けないこと、と ADR 0178 という反例**。

⭐ **[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3 が挙げる
5本の一覧は `AGENTS.md` へ写さない。ADR 0223 を指すだけにする**（ADR 0250/0234 と同じ理由——
一覧は ADR が増えれば動く。この ADR 自身の「⚠ 数を、道具と生成物に焼き込まない」への
自己適用でもある）。

**同じ理由で、`docs/north-star.md` の2つの逐語も `AGENTS.md` へ複製しない。** 新設節は
「同じ形を設計案の判断として先に持っている」と、正しい節名（「迷ったときの問い」「この問いが、
実際に案を落とすことの確認」）を指すだけにする。

### 決定2. 🔴 線は「引けない」と名乗って書く — 埋め合わせない

**⛔ 射程だけを広げると、[ADR 0178](./0178-public-api-surface-gate.md) の公開 API 表面の門
（正当な実装で、偽陽性を承知のうえで採用されている）まで、規約違反に見えてしまう。**

[Issue #505](https://github.com/takecchi/mnemora/issues/505) のコメントが指定した書くべき形を
そのまま採る【受・逐語】:

> **偽陽性率に上限を置けない検査は門にしない。⚠ ただし ADR 0178 は偽陽性を承知で門にしている。
> どちらに倒すかの線は、いまのところ書けていない —— 判断するときは両方の ADR を読むこと。**

**「偽陽性を人が解消する費用で割れる」とは書かない**——それは repo の記録ではなく読みである
（上の「線は引けない」節、陰性対照）。**代わりに、判断が要るときは両方の ADR
（[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)/[0094](./0094-identifier-probes-local-embedding.md)
と [ADR 0178](./0178-public-api-surface-gate.md)）を読むよう指す。**

---

## 検討して採らなかった案

| 案 | ⛔ 落とした理由 |
|---|---|
| **`docs/autonomy.md` へ置く** | [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)「⛔ 成文化の場所」節（「決定2…3…は *道具を作る側* への規律であり、そのどちらの宛先とも一致しない」）と、ADR 0234/0250「採らなかった案」表（「同文書は冒頭で『オーナーに逐一確認せずに作業を進めるエージェントのためのもの』と宣言している。⟹ この規律は、人が対話で書く道具にも当たる。宛先が狭すぎる」）が既に確立した理由をこの ADR でも当て直し、成立することを確認した。 |
| **3本目の宛先（道具を作る側の文書）を新設する** | [Issue #505](https://github.com/takecchi/mnemora/issues/505) のコメントが「6本とも既存の文書の射程を広げる形で書けるので、3本目の入口は要らない」と方針を示している。⚠ 本 ADR が実際に `AGENTS.md` へ書いてみて、既存2文書のどちらにも収まらないとは感じなかった——ADR 0250 決定2 の隣に自然に収まった。 |
| **「偽陽性を人が解消する費用で割れる」と線を書く** | 🔴 **[Issue #505](https://github.com/takecchi/mnemora/issues/505) のコメントが明示的に禁じている。**それは書き手（あるいはコメントの筆者）の読みであって、[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)/[ADR 0178](./0178-public-api-surface-gate.md) のどちらもその言葉で理由を書いていない（上の「線は引けない」節、陰性対照で確認済み）。 |
| **ADR 0178 の反例に触れず、一般形だけを書く** | 🔴 **これが Issue #403 で実際に起きた誤りの形であり（ADR 0234「採らなかった案」も同じ理由で退けている）、ADR 0250 も同じ理由で退けている。**射程だけが伝わると、ADR 0178 の公開 API 表面の門（正当な実装）まで違反として扱われる。 |
| **6つの決定をまとめて1本の PR で成文化する** | ⛔ Issue #505 自身が「1本ずつ判断する」と題に書いている。⚠ 決定5/6/10 は、この ADR では判断していない——マネージャーの指示によりこの ADR では1バイトも触らない（別の担い手が別ブランチで同時に進めている）。 |
| **ADR を書かず、`AGENTS.md` の変更だけ出す** | ⛔ 落ちない。[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) が明示的に「未決のまま残す」と書いた論点（成文化の場所）に答えている。`AGENTS.md` の diff だけでは、なぜ線が書けないのか・なぜ ADR 0178 が違反にならないのかが残らない。 |
| **決定3 の一般形そのものを機械の歯で縛る**（新しく足す CI 検査の偽陽性率が実測されているかを検査する等） | ⛔ 採らない。理由は下の「⭐ 歯を足すか」節。 |

## ⭐ 歯を足すか — ⛔ 足さない

**決定3 の一般形そのもの**（「新しく作る CI 検査が、偽陽性率に上限を置けると実測できているか」）
**を機械で縛ることを検討した。**

⛔ **足さない。理由は2つ。**

1. 🔴 **これは決定3 自身への二重の自己適用になる。**「その検査の偽陽性率に上限を置けたか」の判定
   自体が意味の判定であり、構文の形では機械的に決められない——**まさに [ADR 0250](./0250-machines-detect-humans-confirm-and-write.md)
   が決定2 について同じ理由で足さなかったのと同じ族の限界である**（逐語「偽陽性率に上限を置けるとは
   言えない（ADR 0223 決定3 への自己適用）」）。加えて本 ADR 自身が「線は引けない」と書いている
   以上、**線が無いものを機械に判定させることはできない。**
2. **個別インスタンスの ISSUE がまだ無い**。`gh search issues --repo takecchi/mnemora` に
   「偽陽性率 上限 門」を掛けたが、この規律に反する具体的な CI 検査を指す ISSUE は見つからなかった
   （[Issue #505](https://github.com/takecchi/mnemora/issues/505) 自身がヒットするのみ。上の
   「測ったこと」節に陽性対照つきで記録済み）。⟹ **成文化だけを済ませ、歯は個別の事例が
   出たときの別の判断とする。**

⚠ **この検索は網羅ではない**（下の「確かめていないこと」）。

## 引き受けた負債

- **残る2つ（[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定5 / 6 / 10 のうち、
  本 ADR は関与していない）の宛先は、別の担い手の判断に委ねている。**⟹ この ADR は決定3 の1本だけを
  動かしており、**[Issue #505](https://github.com/takecchi/mnemora/issues/505) は閉じない。**
- 🔴 **線が引けないまま `AGENTS.md` に置く。**⟹ **今後、新しい CI 検査が「これは門にしてよいか」を
  自問したとき、この節は「両方の ADR を読め」としか答えない。**読み手が [ADR 0088](./0088-retrieval-quality-measured-in-ci.md)/[ADR 0094](./0094-identifier-probes-local-embedding.md)
  の理由付け（真の結論を誤らせるコストが高い）と [ADR 0178](./0178-public-api-surface-gate.md) の
  理由付け（偽陽性の解消コストが低い、`--write` 1回で消える）を自分で比較して判断する必要が残る。
- ⛔ **`AGENTS.md` に置いたからといって、守られるとは限らない。**[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
  自身が同じ留保を書いている【現物・逐語】: 「⛔ **「書けば守られる」とは、この ADR は主張しない。**」
- **[ADR 0252](./0252-release-changelog-section-is-a-publish-gate.md) が示した3つ目の根拠
  （偽陽性の出る場面を構造的に列挙できること）は、`AGENTS.md` の新設節には書いていない。**
  ⛔ **一般形だけを書き、個別 ADR の適用パターンは複製しない**という反重複規律（決定1）に
  従った結果だが、**将来「線」を引く ADR を書く人が、ADR 0223 の一覧（0088/0094/0200/0214/0216）を
  開くだけでは ADR 0252 に行き着けない**（ADR 0223 の一覧に ADR 0252 はまだ載っていない——
  0223 のほうが古い）。この ADR の「測ったこと」節に記録することでのみ拾える。
- **`docs/north-star.md` の2逐語が別の節に在るという訂正は、この ADR にしか書いていない。**
  [Issue #505](https://github.com/takecchi/mnemora/issues/505) 本文と
  [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3 は、いずれも
  訂正していない（⛔ ADR 0223 の本文は書き換えない規律により、この ADR からは直せない）。

## これが覆るとしたら

- **[ADR 0178](./0178-public-api-surface-gate.md) 自身の「これが覆るとしたら」が指す条件
  （偽陽性の頻度が高く、担当者が『どうせ赤くなる』と diff を読み飛ばす習慣ができてしまったとき）が
  実際に起きたとき。**⟹ ADR 0178 側が意味的な差分検出へ切り替わり、**「費用が低いから許容する」という
  もう一方の根拠が消える**——そのとき、決定3 の線は「偽陽性率が実測できるか」の一本にまとまる
  可能性がある。
- **[ADR 0252](./0252-release-changelog-section-is-a-publish-gate.md) のような
  「述語が内容を推定しないので偽陽性の出る場面を構造的に列挙できる」という形の適用例が複数積み
  重なったとき。**⟹ それを3つ目の「線」の候補として、別の ADR で改めて検討できる。
- **決定3 に反する具体的な CI 検査（偽陽性率を実測しないまま required にした歯）が ISSUE として
  立ったとき。**⟹ 上の「歯を足すか」で足さなかった理由2（個別インスタンスが無い）が崩れ、
  その事例に閉じた歯を検討する材料が生まれる。
- **残る決定5/6/10 の判定が出そろい、そのうち複数が「`AGENTS.md` では宛先が合わない」となったとき。**
  ⟹ [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) が残した
  「3本目の宛先」を、まとめて作り直す判断になりうる。**その場合もこの ADR の本文は書き換えず、
  追記で訂正する**（[docs/decisions/README.md](./README.md) の規約）。

## 確かめたこと

- **【実測】`ls docs/decisions/ | grep '^0254-'` が1件（この ADR 自身）を返す**ことを確認し、
  ADR 番号 `0254` の衝突が無いことを確かめた。
- **【現物】[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)・[ADR 0094](./0094-identifier-probes-local-embedding.md)・
  [ADR 0200](./0200-adr-renumber-warns-when-titles-need-fixing.md)・[ADR 0214](./0214-release-candidates-lists-not-judges.md)・
  [ADR 0216](./0216-north-star-shipped-only-measurement.md)・[ADR 0178](./0178-public-api-surface-gate.md) の
  該当逐語を、書き手自身が repo を開いて `grep -n` で突き合わせた**（上の「測ったこと」節）。
- **【実測】`docs/north-star.md` を通読し、2つの逐語がそれぞれ「迷ったときの問い」節・
  「この問いが、実際に案を落とすことの確認」節という別の H2 見出しに在ることを確認した**
  （マネージャーからの訂正を受けた再検証）。
- **【実測】`grep -rn "費用" docs/decisions/0088-*.md docs/decisions/0178-*.md`** が0本ヒットである
  ことを確認し、陽性対照として同じ形で `grep -rn "偽陽性"` を実行し複数ヒットすることを確認した。
- **【実測】`pnpm exec vitest run scripts/__tests__/adr-citation.test.mjs
  scripts/__tests__/local-embedding-size-noun-correspondence.test.mjs`** を、`AGENTS.md` への
  変更後に実行し、2ファイル合計75 tests 全て green であることを確認した。
- **【実測】変異試験**（上記「測ったこと」節に詳細）——`AGENTS.md` 新設節の ADR 0178 への言及を
  行番号引用の形へ書き換えると `adr-citation.test.mjs` の該当 test が red になり、`cp` で復元すると
  green に戻ることを確認した。`git checkout` は使っていない。`git status --porcelain` で意図した
  差分（`AGENTS.md` のみ）に戻っていることも確認した。
- **【実測】`gh search issues --repo takecchi/mnemora "偽陽性率 上限 門"`** に
  [Issue #505](https://github.com/takecchi/mnemora/issues/505) 自身のみがヒットすることを確認し、
  陽性対照として `"ADR 0223"` で複数件ヒットすることを確認した（検索が機能していることの確認）。
- **【実測】`git diff --name-only origin/main...HEAD | grep -E '^packages/' | grep -vE
  '__tests__|\.test\.ts|__fixtures__'` が空であることを確認した**（出荷される面への変更が無い）。

## 確かめていないこと

- ⛔ **決定3 に反する具体的な CI 検査（偽陽性率を実測しないまま required にしたもの）が、
  この repo に現存するかどうかは、`.github/workflows/**` と `scripts/**` を1本ずつ通読して
  確かめていない。**`gh search issues` による ISSUE の検索は行ったが、**ISSUE 化されていない
  違反**（誰も気づいていないもの）が無いとは言い切れない。
- ⛔ **`gh search issues` の検索が網羅であることは示していない**（[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
  決定4/決定10 の反例と同じ限界）。
- ⛔ **[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)/[ADR 0178](./0178-public-api-surface-gate.md)
  以外に、決定3 の反例（偽陽性を承知で門にした ADR）が他に無いかは、211本全体を通読して確かめて
  いない。**[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) が挙げた
  反例1本（ADR 0178）だけを根拠にしている。
- ⛔ **[ADR 0251](./0251-release-follow-up-notice-not-a-gate.md)/[ADR 0252](./0252-release-changelog-section-is-a-publish-gate.md)
  以外に、決定3 の個別適用と読める ADR が他に無いかは探索していない。**マネージャーが名指しした
  2本だけを当てた。
- ⛔ **この ADR の判断（線は引けない、と名乗って書く）は、Issue #505 のコメントに書かれていた
  自動化された担い手（クローン miku）の判定を、書き手が現物 ADR（0088/0094/0178）に自分で
  当て直して確認したものであり、オーナー本人に確認していない。**
- ⛔ **残る2つ（決定5/6/10 のうちこの ADR が扱わないもの）については、この ADR では一切調べていない。**
  マネージャーの指示により、この PR の対象外である。
- ⛔ **CI 上での実際のグリーンは、この ADR 執筆時点では未確認。**PR を出した後、CI の結果を別途確認する。

## 関連

- [Issue #505](https://github.com/takecchi/mnemora/issues/505) —— この ADR の判断の出所。
- [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定3 —— 一般形の出所。
- [ADR 0250](./0250-machines-detect-humans-confirm-and-write.md) —— 決定2 の着地。本 ADR が手本にした体裁と置き場所。
- [ADR 0234](./0234-bake-no-numbers-into-tools-and-artifacts.md) —— 決定9 の着地。本 ADR が手本にした体裁。
- [ADR 0088](./0088-retrieval-quality-measured-in-ci.md) / [ADR 0094](./0094-identifier-probes-local-embedding.md) —— 偽陽性率に上限を置けず門にしなかった実例。
- [ADR 0178](./0178-public-api-surface-gate.md) —— 🔴 反例。偽陽性を承知で門にした実例。
- [ADR 0200](./0200-adr-renumber-warns-when-titles-need-fixing.md) / [ADR 0214](./0214-release-candidates-lists-not-judges.md) / [ADR 0216](./0216-north-star-shipped-only-measurement.md) —— 同じ線を独立に採った実例。
- [ADR 0251](./0251-release-follow-up-notice-not-a-gate.md) / [ADR 0252](./0252-release-changelog-section-is-a-publish-gate.md) —— 決定3 の個別適用（0252 は明確、0251 は弱い）。
