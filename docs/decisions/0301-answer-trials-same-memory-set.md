# ADR 0301: `answer` の回答評価を同じ記憶集合での n 回試行・正答数で見る器を作る（Issue #705）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**（ADR 0220 / ADR 0295 / ADR 0296 と同じ形の名乗り）

**⚠ 各主張の出所を分ける**（ADR 0226 / 0233 / 0236 / 0295 / 0296 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で読み・走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 委譲文として受け取り、この ADR の作業者が再導出していない。

---

## 1. 文脈

### 1.1 【受】何が起きたか（ADR 0295 追記2、Issue #705 本文）

PR #698（Issue #691）は `buildMnemoraPrompt` に由来・話者・主題・矛盾候補を描画する変更を
入れ、対照で `schedule-change-meeting-day`（「金曜→水曜」の訂正が後続するケース）が
✅ のままであることを確かめて「退行は消えた」と判定した。**しかし2つの見落としがあった**:

1. **1回しか試行しなかった。** 後で同じ記憶集合で15回試行すると、`digest のみ`=8/15・
   `PR #698 の描画`=3/15・`値が無い欄を省く描画`=0/15 まで割れることが分かった
   （ADR 0295 追記2 §11）。
2. **対照Aと対照Bが、別の抽出・別の recall で得た別の記憶集合の上で回っていた。**
   同じ記憶集合であることを器が確かめていなかった。

Issue #705 はこの2つの穴を埋める器を作ることを完了条件にしている——**同じ記憶集合
（抽出・埋め込み・recall を固定）で回答生成を n 回まわし、ケースごとに正答数（pass/fail/
indeterminate の件数）で見る**・**対照の材料の記憶集合が、比べたい記録と同じであることを
器が確かめて表示する**・**n・モデル・temperature・費用を出力に書く**・**dev/eval の分離を
保つ**・**CI の門にしない**・**実行できなければ未評価として明示する**。

### 1.2 【現物】この作業に着手した時点で在ったもの

- `examples/chat/cassettes/answer.json`（`recordedAt: 2026-09-24T20:59:18.736Z`）が、
  dev 6件・eval 6件それぞれの naive/mnemora 回答プロンプト（計24件）と、抽出プロンプト、
  judge プロンプト、`answer-retention-mutation.ts` の陽性対照用エントリを合わせて
  78件持っている。
- `answer`（`answer-bench.ts`/`cli.ts`）は、Postgres 上で `ingestConversation`/
  `queryRecall` を実際に走らせ、naive/mnemora を1回ずつ回す——**1回しか試行しない**。
  DB・埋め込み・抽出・recall を経由するため、対照A（描画A）と対照B（描画B）を
  別々に呼べば、その都度別の記憶集合になりうる（1.1 の事故の再発条件がそのまま残っている）。
- `mnemora-path.ts` の `renderRecalledMemoryLine` が、`RecalledMemory` から回答プロンプトの
  1行（由来 → 話者 → 主題 → 矛盾候補 → 記録順 → 出来事時刻 → digest）を描画する。

## 2. 決めたこと

### 決定1: 材料は「カセットに記録済みの1つのプロンプト文字列」から静的に復元する。DB・recall を一度もやり直さない

`examples/chat/src/answer-trials-material.ts` は、`examples/chat/cassettes/answer.json` を
`node:fs` で読むだけで、`ANSWER_CASE_SET_DEV` の6件それぞれに対応する mnemora 経路の
回答プロンプト（`buildMnemoraPrompt` が組んだ文字列）を見つけ、`renderRecalledMemoryLine`
の逆変換で構造（`provenanceKind`/`speaker`/`subject`/`contradiction`/`recordedOrder`/
`occurredAt`/`digest`）へ戻す。**`@mnemora/postgres`・`ingestConversation`・`queryRecall` の
どれも import しない。**

**理由（1.1 の事故の再発防止そのもの）**: 事故の芯は「対照Aと対照Bが、気づかないうちに
別の記憶集合になっていた」ことだった。DB・埋め込み・抽出・recall を経由する限り、
2回の呼び出しが同じ記憶集合になる保証は「呼び出し側が同じ入力・同じ tenant・同じ実行
タイミングで呼んだこと」という運用上の注意でしか担保できない——**注意力に頼る規律は
必ず失敗する**（`AGENTS.md` 冒頭「複製した瞬間から、正文と要約はずれ始める」と同じ形の
教訓）。⟹ **構造的に「別の記憶集合になりうる経路」を持たない**設計にした。カセットの
1つのプロンプト文字列だけが記憶集合の唯一の情報源であり、描画 A・B はその同じ材料
オブジェクトを読むだけである（決定2）。

### 決定2: 描画 A（`recorded`）/ B（`digest-only`）は同じ材料オブジェクトへの2つの純関数

`examples/chat/src/answer-trials-render.ts` の `Renderer` インターフェースは
`renderUserContent(material: CaseMaterial): string` だけを持つ。`recordedRenderer` は
`renderRecalledMemoryLine` と同じ形を再構成し、**再構成した文字列がカセットの原文と
完全一致することを毎回検査し、ずれれば例外にする**。`digestOnlyRenderer` は由来等の
タグを一切付けない digest 行だけを出す（ADR 0295 追記2 の「digest のみ」列と同じ形）。

**一致検査を入れた理由**: `MaterialMemoryLine` のパース・再構成のどちらかに欠陥があると、
材料が壊れたまま気づかず試行を回し続ける——n 回試行して出た数字が、そもそも実在した
プロンプトを表していない、という一番気づきにくい壊れ方になる。変異試験(c)（この ADR
末尾）でこの検査自体が効いていることを確かめた。

### 決定3: カセットの sha256・ケースごとの材料指紋を、実行結果に必ず含める

`AnswerTrialsResult`（`answer-trials.ts`）は `cassetteSha256`（カセットファイル全体の
sha256）と、ケースごとの `fingerprint`（正規化した構造——`caseId`/`question`/`system`/
`totalInScope`/`presented`/`lines` をキーでソートした安定 JSON——の sha256）を必ず持つ。
`answer-trials-compare`（`answer-trials-compare.ts`）はこの2つを複数の実行結果の間で
突き合わせ、どちらか一方でもずれていれば、どこがずれたか（どのラベルがどの値か）を
表示して exit 1 にする。

**これが Issue #705 完了条件2「対照の材料の記憶集合が、比べたい記録と同じであることを、
器が確かめて表示する」への回答である。** 決定1により同一プロセス内の対照A/Bは構造的に
揃うが、**別々の実行**（例: 今日回した結果と、先週回した結果、あるいはカセットを
録り直した前後）を比べたいときは、カセット自体が変わりうる——そのときのための、
プロセスをまたいだ確認手段が `answer-trials-compare` である。

### 決定4: n・モデル・temperature・費用を出力する。temperature は数値を捏造しない

`n`（既定5、`MNEMORA_ANSWER_TRIALS_N`）・`model`（`gpt-4o-mini`、`providers.ts` の
`OPENAI_LLM_MODEL` を再利用）を出力する。**`temperature` は `"provider既定（未指定）"`
という固定の文字列を出す**——【現物】`packages/openai/src/llm-provider.ts` の
`OpenAILLMProvider.complete`/`completeStructured` は `chat.completions.create` へ
`temperature` を一切渡していない。実際に使われる値は OpenAI 側の既定であり、この器からは
観測できない。**観測できない値を数値として捏造しない**（`AGENTS.md`「数を、道具と
生成物に焼き込まない」の隣接規律——ここは「焼き込む」ではなく「見えないものを見えると
言わない」だが、同じ「確かめていないことは確かめていないと書く」の適用である）。

費用は `examples/chat/src/usage-meter.ts` の `createUsageMeter` をそのまま再利用する
（新しい価格表を作らない——既存の1箇所だけを唯一の出所にする）。`OPENAI_API_KEY` が
無い run、またはテストが `llmProvider` を DI した run では、`usage`/`costUsd` を
計測しない——**捏造の疑いがある `0` ではなく、`{chatCalls:0, ...}` に固定した上で、
この値が「計測していない」ことを呼び出し側のドキュメント（`RunAnswerTrialsOptions.
llmProvider` の docstring）に明記した。

### 決定5: `OPENAI_API_KEY` が無ければ実 API を一度も呼ばず、「未評価」と明示して exit 0

Issue #705 完了条件「実行できなければ未評価として明示する」への直接の回答。**`recorded`
provider への黙ったフォールバックはしない**——描画 B（`digest-only`）はカセットに
一度も記録されたことが無い入力であり、`RecordedLLMProvider` は記録に無い入力を例外に
する（ADR 0051）。「未評価」を隠さず、exit 0 のまま終える（機械が確定・判定してよいのは
「検出」までであり、「実行できなかった」という事実の開示に留める——`AGENTS.md`「機械には
『検出』まで」の適用）。

### 決定6: eval（`answer-case-set.eval.ts`）は今回は受け付けない

Issue #705 完了条件は「開発ケースと評価ケースの分離を保つ」を求めており、
「eval は明示フラグが無ければ使わない」という書き方を許している。**この PR では
一歩進めて、eval をそもそも配線しなかった**——`answer-trials-material.ts` は
`ANSWER_CASE_SET_DEV` だけをカセットから引き当てる設計である。

**採らなかった案**: eval 6件についても同じ材料抽出器を用意し、`--include-eval` のような
明示フラグ付きで受け付ける案を検討した。**理由**: (a) この PR の主目的（同じ記憶集合で
n 回試行する器そのもの）は dev 6件だけで十分に実演できる。eval の材料抽出は
`answer-trials-material.ts` のロジックをそのまま流用できるが、`docs/autonomy.md` §2.2
決定5「開発時の調整に使うケースと、調整に使わない評価ケースを分ける」——**この PR の
作業者自身が eval のケース定義・カセットの中身を読んで動作確認する過程は、実質的に
「見て調整した」に近づく**（実装したのが機械的パーサであっても、eval の実際のプロンプト
文字列を人が読んで期待通りかを確かめる作業は避けられない）。dev だけに絞れば、この
PR の作業者は一度も eval のケース定義を実装の材料として読まずに済む。(b) eval を
含めると「dev/eval を分けたつもりが、材料抽出のバグ調査で結局 eval の中身を読んでしまう」
という事故の芽を、配線しないことで構造的に断つ。**引き受けた負債**（下記）に残す。

### 決定7: CI の門にしない。n 回の試行結果をカセットに記録しない

Issue #705 完了条件「揺れる意味評価を CI の門にしない（#693 の線）」への回答。
`answer-trials`/`answer-trials-compare` は `.github/workflows/ci.yml` のどのジョブにも
配線しない——`docs/autonomy.md` §2.2 決定3「測定用ベンチと、失敗で変更を止める検査を
分ける」・「意味的品質を測るときに `deterministic` stub へ置き換えない」のうち、
前者の実例である。この器は「測定用ベンチ」側であり、「失敗で変更を止める検査」ではない。

**n 回の試行結果はカセットに記録として残さない**（Issue #705「n 回の試行を記録として
残すかどうかは設計の段で決める」への回答）。**理由**: カセット（ADR 0051）の設計思想は
「記録した実 API の応答の再生」——同じ入力に対して常に同じ出力を返す。この器の目的は
逆に「同じ入力（同じ記憶集合・同じプロンプト）に対して回答モデルの出力が揺れることを
実測する」ことであり、n 回分を1回だけ記録して以後再生すると、**「揺れる」という
器の目的そのものを裏切って「揺れない」ことになる**。⟹ この器は実 API を毎回叩く前提の
観測用 CLI であり、記録・再生の対象にしない。

## 3. 実装した器

- `examples/chat/src/answer-trials-material.ts`: カセットから材料を復元する（決定1）。
- `examples/chat/src/answer-trials-render.ts`: 描画 A/B のレジストリ（決定2）。
- `examples/chat/src/answer-trials.ts`: n 回試行の本体・env の読み取り・表示（決定4/5）。
- `examples/chat/src/answer-trials-compare.ts`: 複数実行の突き合わせ（決定3）。
- `examples/chat/src/cli.ts` の `answer-trials`/`answer-trials-compare` サブコマンド、
  `examples/chat/package.json` の同名 script。

## 4. 【実測】変異試験

DB を使わない module なので、`packages/postgres` のような advisory lock・実 Postgres は
不要——`cp` で退避 → 変異を入れる → 狙った test が赤くなることを確認 → `cp` で戻す →
同じ test が緑に戻ることを確認、という手順を3本行った（`AGENTS.md`「⛔ 変異を戻すのに
`git checkout` を使わない」と同じ手順を、DB 以外の module にも適用した）。

1. **(a) 材料取得で抽出・recall をやり直す実装**: `buildCaseMaterial` がカセットの原文を
   読まず、固定の偽 digest（`"合成された偽のdigest"`）を合成するよう変異させた。
   `__tests__/answer-trials-material.test.ts` の2件が赤くなった——うち1件は
   「digest の中身が実カセットの実測値と一致する」という、この変異試験のために追加した
   陽性対照（`pref-tea-over-coffee`/`schedule-change-meeting-day` の実際の digest 文字列を
   固定した検査）。**この変異は自己整合的**（合成した偽の内容がそれ自体としては
   `recordedRenderer` の一致検査を通ってしまう）ため、`__tests__/answer-trials-render.test.ts`
   側の round-trip 検査だけでは捕まえられない——値そのものを固定した陽性対照が要る
   ことを、この変異試験自身が示した。
2. **(b) compare が指紋を見ずに通す実装**: `compareAnswerTrials` の戻り値の `ok` を常に
   `true` に固定する変異を入れた。`__tests__/answer-trials-compare.test.ts` の3件
   （カセット sha256 の不一致・材料指紋の不一致・ファイル経由の統合試験）が赤くなった。
3. **(c) recorded 描画の一致検査を外した実装**: `recordedRenderer.renderUserContent` から
   一致検査の `if` を削除した。`__tests__/answer-trials-render.test.ts` の1件
   （材料の digest を改ざんしても例外にならなくなったことを検出する検査）が赤くなった。

3本とも、変異を戻した後に同じ test が緑に戻ることを確認した（`diff` で変異前のファイルと
バイト一致することも確認済み）。変異はコミットしていない。

## 5. 引き受けた負債

1. **eval ケース6件はこの PR の範囲外**（決定6）——将来 eval に対する n 回試行が要る場合、
   材料抽出器を eval 用にも拡張する設計判断（フラグの持ち方・「見て調整した」に
   ならない読み方）は、ここでは決めていない。
2. **実 API では動作確認だけを行い、評価はしていない。** マネージャーが gpt-4o-mini
   （temperature は provider の既定）で、n=1 の実行を2回まわした（回答生成の呼び出しは計24回。
   `usage-meter.ts` の価格表で、1回の実行（12呼び出し）あたり約 $0.0004）。2回の結果 JSON を
   `answer-trials-compare` にかけると一致して exit 0 になった。ケースの指紋を1つ書き換えた
   JSON を渡すと、ずれたケースを表示して exit 1 になった。
   この確認で `pnpm run answer-trials-compare -- a.json b.json` が `--` をファイル名として
   開いて落ちる不具合が見つかり、`--` を落とすように直した。
   n=1 の2回では、`schedule-change-meeting-day` の `recorded` 描画が1回目は fail、2回目は
   pass だった。**これは1回の試行では判定できないことの例にすぎず、正答率の測定ではない。**
   ADR 0295 追記2 の 3/15 をこの器で再現するか（n を大きくした評価）は、まだ行っていない。
3. **`answer-trials-compare` はラベルを「ファイル名（`basename`）」で決める**——同じ
   ディレクトリに `a.json`/`b.json` のように区別できる名前で置く運用を前提にしており、
   同名ファイルを別ディレクトリから渡すと分かりにくいラベルになりうる（例外にはしない。
   ラベルの重複だけを検出して例外にする——`compareAnswerTrials` 参照）。
4. **`recordedOrder`/`occurredAt` の値そのものの妥当性は検査しない**——材料抽出は
   タグの構文（`[記録順:N]` の N が正の整数であること等）だけを検査し、値が実際に
   `recall.memories` の並びと整合しているかは検査対象にしていない（そもそも recall を
   経由しない設計なので、検査しようがない——決定1の裏返しの制約）。

## 関連

- Issue #705（本 ADR の対象）、親 #498、Issue #691、Issue #693
- ADR 0295（`buildMnemoraPrompt` の由来等描画）とその追記2（本 Issue の直接の動機）
- ADR 0296（層2・回答に必要な情報の保持の指標。同じ「実データへ配線する」という形を先に採っている）
- ADR 0051（`recorded` カセットの設計、決定7がその設計思想との違いを説明する対象）
- `docs/autonomy.md` §2.2（品質を変える変更の評価と合格基準の扱い。決定7が引く決定3、決定6が引く決定5）
- `AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」「⚠ 機械には『検出』まで」（決定4・決定5の形の根拠）
