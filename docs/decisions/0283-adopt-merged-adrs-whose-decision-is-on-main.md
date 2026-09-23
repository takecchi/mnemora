# ADR 0283: 決定が main で現に採られているのに「草案」「提案」のまま残った ADR 18本を「採用」へ倒す——状態の語を定義する（Issue #641）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-23

> **⚠ この判定は、自動化された担い手（クローンのマネージャーのセッション）のものである。**
> **⛔ オーナー本人の決定ではない。**18本の状態欄を「採用」へ倒したのも担い手であり、
> **オーナー本人がそれぞれを「採用」と判定したのではない**
> （[ADR 0253](./0253-local-embedding-weights-fingerprint-gate.md) 冒頭の追記と同じ名乗り）。
> 署名が repo 上でオーナー本人と区別できないため、ここに書く
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> **担い手が自分で決めてよいと読んだ根拠**は下の「誰が決めてよいか」に置く。

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書・設定を書き手が読んで確かめた。
- **【実測】** — この書き手（またはその作業者）が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取っただけで、この作業では確かめていない。

## 問い

**[Issue #641](https://github.com/takecchi/mnemora/issues/641)**: ADR 273本（当時）のうち30本が「採用」でない状態欄のまま在り、
そのうち24本は決定の実装が `main` に在る。`docs/decisions/README.md` の索引はこの状態欄から機械生成される
（[ADR 0137](./0137-adr-index-generated-from-source.md)）ので、**索引を読んだ人は「30本は決まっていない」と読むが、
その多くは既に動いている。**

⟹ **状態欄を実態へ寄せるか。寄せるなら、どの語が何を名乗るのかを先に決める。**

## 誰が決めてよいか

**「ADR の状態を誰が変えるか」を名指しした明文は、この repo に無い【現物】。**当てた逐語:

- `docs/decisions/README.md`: 「⛔ 採用済み ADR の本文は書き換えない。訂正が要るなら、その場に追記する。」
  「⚠ まだ採用されていない初稿はこの限りではない。」——状態を変える主体は書いていない。
- `docs/autonomy.md` §3「次はオーナーだけが行う」の表（5項目）に、**ADR の状態の変更は無い。**
- `docs/autonomy.md` §3.1: 「技術的に決められるなら決めて、理由を ADR に書く。」
  `docs/roadmap.md` §5（オーナーの判断を集める場所）にも、ADR の状態を扱う項目は無い。
- `AGENTS.md`「作業のときの決まり」: 「勝手に決めない。逆に、そこに無いものは設計側で決めて理由を残す。」
- 前例: [ADR 0253](./0253-local-embedding-weights-fingerprint-gate.md) の 2026-09-21 追記は、マージした担い手が
  「草案」から「採用」へ変えたことを名乗り、その根拠を依頼者の逐語「**ADR は決定の記録であり、マージされた時点で
  その決定は現に採られている**」に置いている。同じ追記は「明文の規約を読んで決めたのではない」「慣例は揃っていない」
  とも書いている。

⟹ **この ADR は、上の一般則（§3 に無く §5 にも無いものは、設計側が理由を ADR に残して決める）を根拠に担い手が決める。**
⚠ **個別に委任した逐語は無い。**Issue #641 の起票者（これも担い手）は逆に「オーナーの領分」と読んでいた。
⟹ **この読みが誤りなら、覆す条件は下の「これが覆るとしたら」に書く。**

## 決定

### 1. 状態の語を定義する

| 語 | 名乗ること |
|---|---|
| **採用** | **その決定が `main` で現に採られている**（決定が要求するコード・歯・文書の規律が `main` に在る、または決定そのものが「〜しない」と決めてそのとおりになっている）。**誰が採用と判定したかは名乗らない**——それは本文の名乗りが持つ |
| **提案** | **「採用」と名乗る根拠が、まだ揃っていない。**決定の実体が `main` に無い／オーナーの確認を待っている／決定の中身が記録そのもので「実体が在るか」では判定できない、のどれか。どれに当たるかは本文が持つ |
| **草案** | **マージ前の PR ブランチ上でだけ使う語。**`main` に「草案」のまま在る ADR は、マージ時に状態を当て直し損ねた形である |
| **未決** | 実測の記録であり、決定そのものを保留している（ADR 0025 が唯一の実例） |

⚠ **この定義は、語の意味を後から固定するものであって、過去の ADR の書き手がこの意味で書いたとは主張しない。**
⚠ **「採用」は「オーナーが本文を読んだ」を意味しない。**オーナー本人の関わり方は、各 ADR の冒頭の名乗りが持つ。

### 2. 次の18本の状態欄を「採用」へ倒す

**判定基準**: ADR の「決定」節が要求するもの（仕組み・コード・歯・文書の記述）が、`main` = `a806606` に動く形で在るか。
「言及されているだけ」は在ると認めない。**18本とも、ADR を足した squash commit が実装も運んでいる**（同じ PR）【実測】。

| ADR | 倒す前 | 実体（根拠の例） | ADR と実装を入れた commit |
|---|---|---|---|
| [0235](./0235-correction-demo-explicit-choice.md) | 草案 | `examples/chat/src/correction-demo.ts` の `CorrectionOutcomeKind` と、`__tests__/correction-demo.test.ts` | `87936b8`（#522） |
| [0238](./0238-correction-choice-rationale-in-events.md) | 草案 | `buildCorrectionReason`（当時は `correction-demo.ts` 内。いまは 0242 が `packages/core/src/apply-correction.ts` へ移した。決定が求めた形式は保たれている） | `242ce7f`（#525） |
| [0242](./0242-runtime-apply-correction.md) | 草案 | `packages/core/src/runtime.ts` の `applyCorrection` と `packages/core/src/__tests__/apply-correction.test.ts` | `dc995fa`（#537） |
| [0244](./0244-runtime-method-doc-correspondence-tooth.md) | 草案 | `scripts/__tests__/runtime-method-doc-correspondence.test.mjs` の `CORE_VERBS` | `1063996`（#543） |
| [0245](./0245-publish-gate-shell-default-pinned.md) | 草案 | `scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs`（5件、手元で緑を実行して確認） | `420e0f4`（#546） |
| [0246](./0246-association-rank-includes-decay.md) | 草案 | `packages/core/src/recall-runtime.ts` の `rankKey` と `recall-association-usage-ranking.test.ts`（4件、緑を確認） | `f42a396`（#549） |
| [0247](./0247-local-embedding-repo-model-id-declaration-guard.md) | 草案 | `local-embedding-provider.ts` のコンストラクタのガードと `repo-model-id-declaration-guard.test.ts`（5件、緑を確認） | `a6caef1`（#550） |
| [0257](./0257-searched-and-found-nothing-versus-did-not-search.md) | 提案 | `AGENTS.md`「⚠ 「無かった」と書く前に、探した場所を列挙する」節（決定が歯を意図して作らない文書の規律） | `d7c70c0`（#571） |
| [0264](./0264-cli-names-the-mismatch-between-plan-and-actual.md) | 提案 | `examples/chat/src/cli.ts` の `detectPlanActualMismatch` と `__tests__/plan-actual-mismatch.test.ts` | `6a4ab66`（#598） |
| [0265](./0265-fingerprint-gate-shell-branches-pinned-by-execution.md) | 草案 | `scripts/__tests__/ci-yml-local-embedding-fingerprint-shell.test.mjs` | `840ba9b`（#600） |
| [0268](./0268-living-doc-judgment-pointer-repointed-to-605.md) | 草案 | `scripts/__tests__/living-doc-judgment-pointer-consistency.test.mjs` | `3875a05`（#607） |
| [0270](./0270-runtime-method-count-bake-detection-tooth.md) | 提案 | `scripts/__tests__/runtime-method-count-not-baked.test.mjs` の `BAKED_METHOD_COUNT_RE` | `bc60391`（#613） |
| [0272](./0272-runtime-method-count-notation-sweep.md) | 提案 | 同じテストの `KANJI_DIGITS` / `COUNTER_WORD` | `74c5295`（#614） |
| [0274](./0274-required-check-context-name-is-frozen-annotate-dont-rename.md) | 提案 | `.github/workflows/ci.yml` の example-chat ジョブ直上の注記と、`AGENTS.md` の required check 文脈名の注記 | `7ee4985`（#617） |
| [0277](./0277-adr-renumber-detects-unrewritten-chain-references.md) | 提案 | `scripts/adr-renumber-lib.mjs` の `findUnrewrittenAdrReferences`（`scripts/adr-renumber.mjs` が配線） | `45c58b7`（#621） |
| [0278](./0278-architecture-section5-port-interface-correspondence-tooth.md) | 提案 | `scripts/__tests__/architecture-section5-port-interface-correspondence.test.mjs` の `TARGET_INTERFACE_NAMES` | `8b176dd`（#624） |
| [0279](./0279-required-status-checks-declaration-and-check.md) | 提案 | `.github/required-status-checks.json` と `scripts/check-required-status-checks(-lib).mjs` | `15dcbf4`（#623） |
| [0280](./0280-compare-omitted-stage-declaration-gate.md) | 提案 | `scripts/compare-omitted-stage-declaration-lib.mjs` と `ci-yml-compare-omitted-stage-declaration-wiring.test.mjs`（追記1の修正は `aa985dd`、#632） | `e986d36`（#625） |

**倒し方**: 各 ADR の状態行だけを、`採用 (<元の日付>。ADR 0283 で担い手が「<倒す前の語>」から倒した——オーナー本人の判定ではない)`
の形に置き換える。**本文と冒頭の名乗りには触らない。**元の日付は、状態行に日付が在ればそれ、無ければ `- **日付**:` 行の値。

⚠ **「草案」だった9本の状態行が持っていた括弧書き**（「`docs/decisions/README.md` は触っていない——ADR 0137 決定2。
索引はマージする側が直前に再生成する」）**は、PR 作成時の手順の注記であって決定の記録ではない**ので、置き換えで消える。
元の文言は git の履歴に残る。

### 3. 🔴 採用に倒すと、以後その本文は追記しか許されない

`docs/decisions/README.md` の「⛔ 採用済み ADR の本文は書き換えない。訂正が要るなら、その場に追記する」は、
**この18本にも、倒した時点から掛かる。**これまでは「まだ採用されていない初稿はこの限りではない」の側に在った。
⟹ **18本の本文を直す必要が後で見つかったら、書き換えずに追記を積むこと。**

### 4. 外した6本と、その理由

Issue #641 が「実装が在る」とした24本のうち、次の6本は**倒さない**（「提案」のまま残す）。

| ADR | 外した理由 |
|---|---|
| [0260](./0260-answer-names-what-it-actually-runs.md) / [0261](./0261-answer-bench-tenant-keyed-by-embedding-space.md) / [0262](./0262-cli-names-the-plan-as-a-plan.md) / [0263](./0263-cache-key-carries-the-model-revision.md) | **本文が「⛔ 本文の逐語は読んでいない」と名乗っている**（0260〜0262 は「オーナー本人は方針を承認している」、0263 は「依頼者（クローン）が案を選んだ」に続けて）。**この名乗りは、採用済みの ADR には0本で、この4本にだけ在る**【実測】。⟹ 「提案」という状態欄が「オーナーが本文を読んでいない」という信号を運んでいる可能性を否定できない。**それを否定できないまま「採用」へ倒すと、未読という事実を状態欄から消すことになる。**⟹ この4本は、オーナーへ束ねて確かめる側に置く（この ADR では扱わない） |
| [0269](./0269-port-interface-doc-correspondence-sweep.md) / [0273](./0273-architecture-section5-is-a-copy.md) | **決定の中身が記録そのものである**（0269 は掃引の結果の表、0273 は「§5 は写した側である」という解釈）。0273 の決定に従った修理は別の PR（`6253edf`、#622）が行っている。⟹ **「決定が要求する実体が main に在るか」という、この ADR の判定基準では判定できない。**Issue #641 自身も、この2本は「便宜上『実装あり』に入れた」と書いていた |

### 5. 触らないもの

- **[ADR 0074](./0074-impression-topic-growth-what-mnemora-cannot-hold.md) と [ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md)**: 状態欄そのものが「オーナーの判断待ち」「直し方はオーナーと決める」と書いている。**⛔ この ADR はこの2本に一切触れない。**
- **ADR 0135 / 0185 / 0275 / 0271**: 「提案」のまま残す。Issue #641 の判定では、0135・0185・0275 は本文が「実装を含まない提案・棚卸し」と名乗り、0271 は ADR 自身が指示した CHANGELOG の追記だけが欠けている【受】。**この作業ではこの4本を当て直していない。**

⟹ **この ADR の後、「採用」でない ADR は12本になる**（0025 / 0074 / 0135 / 0185 / 0260 / 0261 / 0262 / 0263 / 0269 / 0271 / 0273 / 0275）。

### 6. 歯は作らない

候補は「`main` に『草案』の ADR が無い」を縛る歯だった（決定1の定義から直接出る）。**作らない。**
ADR を足す PR は作成中「草案」を名乗るのが今の作法なので、この歯を CI の `pull_request` で走らせると、
**すべての ADR PR が、マージ直前に状態を当て直すまで赤くなる**——ADR 0137 / [ADR 0192](./0192-adr-index-freshness-enforced-in-pull-request-ci.md) の索引の赤と同じ形の儀式を、
もう1つ増やすことになる。**それはこの ADR の問い（既に在る18本を実態へ寄せる）より広い変更である。**⟹ 下の「引き受けた負債」に置く。

## 採らなかった案

- **何も倒さず、今後の規約だけを決める。**——状態欄と実態がずれたまま索引に出続ける。Issue #641 の問いに答えていない。
- **24本すべてを倒す。**——0260〜0263 の未読の信号を消しうる。0269・0273 は判定基準に乗らない（決定4）。
- **状態の語を増やす**（例: 「採用（オーナー未読）」）。——`generate-adr-index-lib.mjs` の `formatStateCell` は見出し語を括弧の手前までで切るので、表示の上では区別が付かない。語彙を増やすなら、その判断を 0260〜0263 の扱いと一緒にオーナーへ持っていく方が早い。
- **倒す理由を18本それぞれの本文へ追記する。**——18本は倒すまで「初稿」の側に在り、状態行の置き換えだけで足りる。追記を18本に積むと、同じ文を18回複製する。理由はこの ADR 1本に置き、状態行からここを指す。

## 引き受けた負債

1. **「草案」を `main` に残さない歯が無い**（決定6）。⟹ マージする側が状態を当て直し忘れれば、同じずれがまた積もる。
   ADR 0253 の追記が記録した「慣例は揃っていない」は、この ADR の後も**機械では止まらない。**
2. **ADR 0137 決定2 のマージ手順（索引の再生成）に「状態を当て直す」一手を足していない。**足すなら ADR 0137 への追記か手順を持つ文書の変更になり、この ADR の範囲を越える。
3. **決定1の定義を、`docs/decisions/README.md` の冒頭には写していない。**写すと正本が2つになる。README から辿れる形（この ADR を指す一文）も、今回は足していない。

## これが覆るとしたら

- **オーナーが「ADR の状態を変えるのはオーナーだけ」と決めたとき。**——この ADR の「誰が決めてよいか」の読みが誤りだったことになる。18本の状態行を元へ戻し、その経緯をこの ADR へ追記する。
- **0260〜0263 について、オーナーが「未読は状態欄で表す必要はない」と答えたとき。**——決定4の外した理由が消え、同じ基準で倒せる。
- **18本のどれかについて、決定の実体が `main` から消えたとき。**——状態を戻すのではなく、その ADR に追記して何が消えたかを書く（採用済みの規律）。

## 確かめたこと・確かめていないこと

- **【実測】** 状態欄の分布（`main` = `a806606`）: ADR 274本のうち、採用 244、提案 20、草案 9、未決 1。非採用の30本は Issue #641 の30本と同じ顔ぶれだった。
- **【実測】** 「本文の逐語は読んでいない」の名乗り: 状態欄で「採用」の ADR には0本、非採用の側では 0260 / 0261 / 0262 / 0263 の4本だけ。
- **【実測】** 18本すべてで、ADR を足した commit（`git log --diff-filter=A`）と実装を運んだ commit が同じだった（表の最右列）。
- **【実測】** 0245 / 0246 / 0247 のテストは手元で実行して緑だった。**他の15本は、テストやスクリプトの実在と CI への組み込みを確かめたが、手元で実行してはいない。**
- **【受】** 18本の判定の大半は、作業者（担い手が切り出した調査のセッション）の報告を集約したもので、書き手はファイルの実在・配線・状態行を抜き取りで当て直した。作業者の報告には誤りが2つあり（0244 に状態行が無い、0261 の名乗りの主語がクローン）、どちらも書き手が現物で直した。⟹ **同じ種類の誤りが他に残っている可能性は否定できない。**
- **確かめていない**: 0135 / 0185 / 0275 / 0271 の判定（決定5）。0238 の実体が 0242 で移ったことを「採られている」と読んでよいかは、解釈に幅がある（表に書いた）。
