# 北極星「目指す姿」の各項目を満たしている、出荷物の経路

> ⚠ **オーナーの確認待ち。クローン miku の判断で置いた。**
> どの経路がどの項目を満たすとみなすか（この一覧の中身）は、クローン miku の所見であって
> オーナーの判断ではない。

**roadmap §7 の数は日付の記録で、現在形はこの一覧である。**
`docs/roadmap.md` §7 の「在る5 / 半分2」「在る6 / 半分1」などは、それぞれの日にそう数えた
記録として凍結されている（§7.0 の規律）。いまの数はこの一覧が持つ: **7項目すべて在る。**
（⚠ 2026-09-29 追記: この文書が指す roadmap §7（§7.0・§7.12・§7.15・§7.18 を含む）は削除した（#762）。当時の本文は
[`635c93d` の版](https://github.com/takecchi/mnemora/blob/635c93dcda148f44cf6b51ac2407b28596fccb32/docs/roadmap.md?plain=1#L497-L1837) にある。
§7.12 は L953–L1045、§7.15 は L1241–L1351、§7.18 は L1578–L1661。）

- **項目の文面はここに写さない。**番号は [docs/north-star.md](./north-star.md)「目指す姿」の
  箇条の順である（`AGENTS.md`「ここに北極星の要約を置かない」）。
- **行番号は書かない。**ファイルと、テストの it の名前（逐語）と、公開 API の名前で指す
  （`AGENTS.md`「数を、道具と生成物に焼き込まない」）。
- **当て直した時点: 2026-09-28、`main = de8a160`。**それより後に `main` が動いた分は、
  この一覧の中身としては確かめていない。項目1 の節だけは 2026-09-28、`main = e1d5b40` で
  当て直した。

## 歯が確かめること / 確かめないこと

`scripts/__tests__/north-star-paths.test.mjs` がこの文書を読み、**参照先が実在すること
だけ**を確かめる（[Issue #387](https://github.com/takecchi/mnemora/issues/387)）。

- `口:` の名前が、`scripts/__snapshots__/public-api/<パッケージ>.d.ts`（公開 API の
  スナップショット、ADR 0178）に語として在る。
- `実装:` のファイルが在る。
- `テスト:` のファイルが在り、「」の中の名前が `it(`／`test(` の第1引数として逐語で在り、
  その宣言が `.skip`／`.fails` でない（名前がコメントや別の文字列にあるだけでは足りない）。
- `docs/north-star.md`「目指す姿」の箇条それぞれに、この文書の `### 項目N` の節が在る。

⛔ **項目が満たされているかは判定しない。**参照先が全部在っても、項目が外から見て
満たされていることにはならない。
⛔ **「参照先が出荷パッケージの中か」も確かめない。**ADR 0216 が「(ア)」で退けた検査である
（項目3・4 を毎回「半分」と出してしまう）。
**門にするかどうかと、この一覧の中身をどうするかは、オーナーに残っている**（#387）。

各項目の既定の経路で差が出るかを実際に走らせて印字するのは、別の道具
（`scripts/north-star-default-probe.mjs` / `scripts/north-star-tarball-probe.mjs`、
ADR 0216 決定7）である。この一覧は、それを置き換えない。

## 経路

### 項目1

**在る。**`observe()` で書いた記憶に減衰の床（`decayFloorAt`）が付き、`recall()` は既定で
床をまだ越えていない記憶だけを返す。既定の壁時計なら、床は1日よりずっと先になる。

- 口: `core` `createRuntime`
- 口: `core` `defaultDecayStrategy`
- 口: `core` `includeFullyDecayed`
- 実装: `packages/core/src/extraction.ts`
- 実装: `packages/core/src/strategies/decay.ts`
- 実装: `packages/core/src/recall-runtime.ts`
- テスト: `packages/postgres/src/__tests__/north-star-item1-next-day.postgres.test.ts` 「注入した時計で observe し、1日と1時間進めてから recall しても、その記憶が返る（既定のテナント設定、includeFullyDecayed なし）」
- テスト: `packages/postgres/src/__tests__/north-star-item1-next-day.postgres.test.ts` 「陽性対照: 同じ時計を1年進めると、その記憶は返らず filtered(decayed) に数えられる（時計が減衰ゲートまで届いている）」
- テスト: `packages/core/src/__tests__/decay.test.ts` 「threshold 省略時の floorAt が 0.05 由来の絶対時刻になる」
- テスト: `packages/core/src/__tests__/recall-decay-gate.test.ts` 「既定（includeFullyDecayed 未指定）では VectorStore.search の opts.filter.decayFloorAtAfter に「いま」が渡る」

最初の2本は、Postgres と testkit の fixture の両方で走る。
⚠ 活動時計（`decayClock: 'activity'`）のテナントでは、`recall()` の回数が多いと破れうる。境界は本物の Postgres で実測済みである
（#338、[ADR 0311](./decisions/0311-activity-clock-boundary-measured-soft-and-hard.md)。数はここに写さない）。Issue は閉じており、
活動を数える単位は呼び出しの引数 `activityCounting` で選べる（[ADR 0353](./decisions/0353-activity-counting-per-call.md)。既定は変わらない）
（[ADR 0561](./decisions/0561-doc-code-drift-sweep-recall-testkit.md)）。

### 項目2

**在る。**連想枠（`RecallQuery.association`）が `@mnemora/core` で既定 on になった。

| 確かめたこと | 結果 |
|---|---|
| `packages/core/src/recall.ts` の `export const DEFAULT_RECALL_ASSOCIATION` | 在る |
| `recall-runtime.ts` が association の省略時に `DEFAULT_RECALL_ASSOCIATION` を当てる | 在る（既定 on） |
| ADR 0337（既定 on にした決定） | 採用 2026-09-26 |
| その変更（PR #838）が出荷されたか | v1.0.2 に入っている（`git merge-base --is-ancestor`）。npm の `@mnemora/core` に 1.0.2 が在る |
| 既定 on で項目6 が破れないか | ADR 0188 は採用済みで、連想枠の切り捨ても `omitted` に出る。#375 / #337 は CLOSED |

⟹ roadmap §7.12 が「半分」とした理由3点（出荷物の既定が off／on にする唯一の呼び手が
出荷されない／`examples/chat` が無いと立たない）は、どれも当たらなくなった。
（⚠ 2026-09-29 追記: §7.12 は削除した（#762）。冒頭の追記のリンク先で読める。）
⚠ 連想枠が想起の質を上げるかは別の問いで、ここには入れていない（docs/recall.md §9.7）。

#### オーナーの回答（2026-09-16）—— 正典 項目2 の文言は変えない

⚠ 2026-09-29 追記（#762）: roadmap §7.4 を削除したため、そこが repo 内で唯一記録していたこの回答を、ここへ移した。`docs/north-star.md` 項目2 の文言を書き換える提案は、**一度選ばれたあと、オーナーが文言を見て撤回した**。この回答はいまも効いている（正典は1バイトも変わっていない）。
下は、旧 §7.4「⛔ 項目2 を『在る』と数えなかった理由」の ⭐ 追記（2026-09-16）の1〜3番の**逐語の写し**である。
出所: [旧 roadmap の §7.4（`635c93d` の版）](https://github.com/takecchi/mnemora/blob/635c93d/docs/roadmap.md#74-充足状況2026-09-16-再監査現物のコードから)。
⚠ 当時の項目2 の判定「半分」は、その後の ADR 0337（既定 on）で「在る」になっている（上の表）。移したのは判定ではなく、文言についての回答である。

1. **オーナーは (ろ) を選んだ**（逐語: 「**(ろ)でお願いします**」）。⟹ 担い手が `docs/north-star.md` 項目2 の書き換え案を作り、[#350](https://github.com/takecchi/mnemora/pull/350) として出した（CI は全件緑だった）。
2. **提示した文言案は、これである。**⛔ **何が却下されたか分からない記録は、記録として役に立たない**ので、案そのものを残す。

   | | 文言 |
   |---|---|
   | **変更前（＝現行。これが残った）** | `- **聞かれていないことを、自分から思い出す。**` |
   | **変更案（＝却下された）** | `- **使う側が有効にすれば、聞かれていないことを、自分から思い出す。**——有効にするのは使う側だが、何を思い出すかは mnemora が決める。` |

3. **オーナーは文言を見たうえで撤回した**（逐語: 「**やっぱいいや。変更はなしで。普通に『聞かれていないことを、自分から思い出す。』のほうがわかりやすくていいです**」）。⟹ **[#350](https://github.com/takecchi/mnemora/pull/350) は close し、`docs/north-star.md` は1バイトも変わっていない。**

- 口: `core` `DEFAULT_RECALL_ASSOCIATION`
- 口: `core` `RecallAssociationQuery`
- 実装: `packages/core/src/recall.ts`
- 実装: `packages/core/src/recall-runtime.ts`
- テスト: `packages/core/src/__tests__/recall-association.test.ts` 「association を省略すると DEFAULT_RECALL_ASSOCIATION が適用され、byTier.association が現れる（既定 on）」
- テスト: `packages/core/src/__tests__/recall-association.test.ts` 「association: null を渡すと、連想は一切走らない（ADR 0151 以前の振る舞い、明示的な opt-out）」

### 項目3

**在る。**`recall()` は毎回 recall の記録を書き、`getRecall(recallId)` で後から読み戻せる。
`explain.stages` は各段が実際に使った設定を名乗る。

- 口: `core` `getRecall`
- 口: `core` `RecallRecord`
- 実装: `packages/core/src/runtime.ts`
- 実装: `packages/core/src/recall-runtime.ts`
- 実装: `packages/postgres/src/memory-store.ts`
- テスト: `packages/core/src/__tests__/runtime.test.ts` 「createRecall で書いた行を、memoryStore.getRecall と同じ内容で読み戻す」
- テスト: `packages/core/src/__tests__/recall-decay-gate.test.ts` 「explain.stages の detail.clock が実際に使ったテナントの時計を名乗る（'activity'/'either'、北極星の問い3）」

⚠ 「なぜ思い出したか」を読むのは採用者である（ADR 0216 決定1 の類丙）。ここで縛っているのは、
記録が残り読み戻せることまでである。

### 項目4

**在る。**使用報告（`observe` の `memory_usage`）が記憶を強化し、報告されない記憶は減衰の
床を越えて `recall()` から遠ざかる（消えずに `filtered(decayed)` として名乗る）。

- 口: `core` `memory_usage`
- 口: `core` `includeFullyDecayed`
- 実装: `packages/core/src/runtime.ts`
- 実装: `packages/core/src/recall-runtime.ts`
- テスト: `packages/core/src/__tests__/recall-usage-selection.test.ts` 「A を使用報告し B を報告しないと、T2 の recall() で A は返り B は filtered(decayed) になる」
- テスト: `packages/core/src/__tests__/recall-usage-selection.test.ts` 「対照条件: どちらも使用報告しなければ、T2 の recall() では両方とも落ちる（歯が『A は何をしても残る』で通っていないことの検算）」

⚠ 使用報告を送るのは採用者である（類丙）。roadmap §7.18 のオーナー決定（2026-09-19）で、
連想枠が既定 on であることはこの項目の「在る」を妨げない扱いになっている。
（⚠ 2026-09-29 追記: §7.18 は削除した（#762）。冒頭の追記のリンク先で読める。）

#### オーナーの決定 `29bf959c`（2026-09-19）—— 項目4 の留保を解く

⚠ 2026-09-29 追記（#762）: roadmap §7.18 を削除したため、そこが repo 内で唯一記録していたこの決定を、ここへ移した。完了したのは計画であり、**この決定はいまも効いている**。
下の表は、旧 §7.18「🔴 決定そのもの —— 出所を先に書く」の表の**逐語の写し**である。表中の「§7.4」「§7.17」「⚠3」は旧 roadmap の節を指す。
出所: [旧 roadmap の §7.18（`635c93d` の版）](https://github.com/takecchi/mnemora/blob/635c93d/docs/roadmap.md#718--正典項目4-の留保を解くオーナー決定-2026-09-19--担い手が検証して得た結論ではない)。
⚠ 旧 §7.18 の文章は担い手（クローンのマネージャーのセッション）が書いたものであり、オーナー本人の文章ではない。オーナー本人のものなのは、表が記録している*決定*である（旧 §7.18 の冒頭の断り）。

| | |
|---|---|
| **決めた人** | 🔴 **オーナー（takecchi）本人** |
| **決めた日時** | **2026-09-19T22:42Z**（UTC。JST では 2026-09-20 07:42） |
| **経路** | クローンが `ask_human` で問い、**オーナー本人が答えた**（回答 id `29bf959c`、選ばれたのは選択肢「(あ)」）。⛔ **問いと選択肢の全文は、この repo の中には無い** |
| **決定の中身** | **§7.4 の ⚠3 の留保を解き、§7.17 の差分をもって正典「目指す姿」項目4「使われない記憶が、静かに遠ざかる」を満たしたとする** |
| 🔴 **出所の性質** | **これはオーナーの決定である。⛔ 担い手が技術的に検証して得た結論ではない。**この節の書き手は、⚠3 が記録した窓（129.658日 / 連想枠 on の返却の 47.5%）も、§7.17 の修理がその窓を閉じたことも、**自分で測り直していない**【受】 |
| ⛔ **repo からの検算** | **できない。**GitHub 上の `takecchi` は**オーナー本人とクローンの両方**であり、署名から区別が付かない（ADR 0220）⟹ ⛔ **repo 上のコメントを、この決定の根拠として引いていない。**根拠は上の `ask_human` の回答だけである |

### 項目5

**在る。**明示操作の `applyCorrection` が、古い側を `superseded` にし、以後の `recall()` に
出さない。

- 口: `core` `applyCorrection`
- 口: `core` `resolveContested`
- 実装: `packages/core/src/runtime.ts`
- 実装: `packages/postgres/src/memory-store.ts`
- テスト: `packages/core/src/__tests__/resolve-contested.test.ts` 「markContested → recall（両方出る・mandatory_companion・隣接）→ resolveContested(supersede) → recall（敗者はもう出ない・勝者は active で単独）」
- テスト: `packages/core/src/__tests__/apply-correction.test.ts` 「correctedId が無ければ書き込みを1件もせずに awaiting_choice を返す」

⚠ 根拠は明示操作である（roadmap §7.15）。既定の経路（`applyCorrection` を呼ばない）では、
段1の probe は「差が出なかった」と印字する。§7.15 の「埋まっていないもの」3点は、
この一覧では解いていない。
（⚠ 2026-09-29 追記: §7.15 は削除した（#762）。冒頭の追記のリンク先で読める。）

### 項目6

**在る。**`recall()` は落とした分を `omitted` に種類ごとに名乗る。連想枠が既定 on でも、
連想枠の切り捨ては `over_limit(association)` として出る（ADR 0188）。

- 口: `core` `Omission`
- 実装: `packages/core/src/recall-runtime.ts`
- 実装: `packages/core/src/recall.ts`
- テスト: `packages/core/src/__tests__/omission-kind-generation.test.ts` 「zod schema の判別子は11個あり、重複していない」
- テスト: `packages/core/src/__tests__/recall-pipeline.test.ts` 「status='superseded'/'forgotten' は別々の filtered omission として報告される（ADR 0027、束ねない）」
- テスト: `packages/core/src/__tests__/recall-association-seatless-companion.test.ts` 「(c) 同伴として取られていない、席を競り負けただけの候補は over_limit(association) に残る（過剰実装を捕まえる歯）」

### 項目7

**在る。**`RecallQuery.budget` を渡したときだけ段4が切り詰め、渡さなければ切り詰めない
（既定値を入れない）。落とした分は `budget_dropped` に出る。

- 口: `core` `RecallBudget`
- 実装: `packages/core/src/recall-runtime.ts`
- テスト: `packages/core/src/__tests__/recall-channels.test.ts` 「②-a 全体の一致: RecallResult 全体を JSON 直列化してリテラルと突き合わせる」
- テスト: `packages/core/src/__tests__/recall-budget-channel-registry.test.ts` 「inside_budget と宣言した digest チャンネルは、きつい予算で実際に落ちる」
