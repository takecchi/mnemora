# ADR 0296: `answer` に層2（回答に必要な情報の保持）の決定的な指標を足す — 出典到達・回答正誤とは別欄、記録カセットの録り直しを要求しない（Issue #693、親 #498）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**（ADR 0220 / ADR 0295 と同じ形の名乗り）

**⚠ 各主張の出所を分ける**（ADR 0226 / 0233 / 0236 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で読み・走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 委譲文として受け取り、この ADR の作業者が再導出していない。

---

## 文脈

Issue #693（親 #498）の完了条件は、`compare` の `factStatementSurvived`（出典到達、ADR 0226）
の意味を変えずに、`answer` の品質・実際の入力・抽出/埋め込み費用を対で評価すること、
同一出典のまま答えの情報を削る陽性対照が失敗し復元で成功すること、開発/評価ケースの分離と
録音条件・鮮度・未評価の報告、固定条件の回帰検査の CI 接続を求めている。

**【現物】この作業に着手した時点で、#498 の大半はすでに main へ着地していた**:

- 層1（出典到達）: `provenance-trace.ts` の `resultContainsObservation`。ADR 0052 / 0226。
- 層3（最終回答の正しさ）: `gradeAnswer`（一次判定、`answer-case.ts`）・`judgeAnswer`
  （二次観測、`answer-judge.ts`）。`answer-bench.ts`/`answer-json.ts`/`answer-format.ts` が
  naive/mnemora を対で回し、入力量・呼び出し回数（抽出/埋め込み/回答生成/judge）を
  ケースごとに出す。`answer-cli.postgres.test.ts` が `recorded`（記録済みカセットの再生）で
  CLI を実際に子プロセス起動し、`example-chat` ジョブの `test:db` 経由で CI に接続済み
  （required status check）。
- 層2（回答に必要な情報の保持）の**変異試験**: ADR 0236（PR #523）が
  `provenance-trace.test.ts` に、`buildMnemoraPrompt` の出力から答えの語が消える一方で
  層1が `true` のままであることを、**1個の作り物のケース**（架空の答え「青」）に対して
  固定していた。
- 層2の**回答評価（judge が変異を検出する）側**は、カセット（`answer.json`、67件 =
  抽出26 + 回答生成24 + judge17、回答生成24件は12ケース×{naive,mnemora}で余り0）が
  変異後のプロンプトを1件も持たないため未達のまま——**実 API での記録追加を要し、
  鍵の判断はオーナーの領分**（Issue #498 コメント2026-09-18、ADR 0184 決定4）。この ADR は
  この領域には触れない（下記「範囲外」）。

**⟹ この ADR が実際に埋めるのは次の隙間である**: 層2の指標が**1個の作り物のケースにしか
固定されておらず、`answer-bench.ts`/`answer-json.ts` の実データ（実ケース集合・実行結果）
には一度も配線されていない**——`compare` の `factStatementSurvived` のような、ケースごとの
恒常的な欄が層2には無かった。

## 【実測】カセットの現物確認 —— 層2は層3と独立であることを実データで示せる

`examples/chat/cassettes/answer.json`（`recordedAt: 2026-09-17T12:55:00.865Z`、
`llm.model: gpt-4o-mini`、`embedding.space: {provider: "openai", model:
"text-embedding-3-small", dimensions: 256}`）を `node -e` で直接読み、`prompt.system` で
分類し、mnemora 側（`索引:` を含む messages）24÷2=12件全部の digest 文字列を出力させた。

**10件の closed-value ケース全部で、`expected.accept` の少なくとも1つが digest に
そのまま部分文字列として残っている**（例: `紅茶`・`水曜`・`神戸`・`9月10日`・`福岡`・
`窓側`・`デザイナー`・`カレー`・`大阪`、そして下記の `25日`）。

**`schedule-change-deadline`（`answer-case-set.eval.ts`、`tuningUse: "held-out"`）が
特に示唆的である**:

```
- 報告書の提出期限は今月の20日である。
- 提出期限を25日に延ばしてもらいたいという要望がある。
- 20日に間に合わないので、期限延長の理由がある。
- 週末は友達と出かける予定である。
(索引: スコープ内 5 件のうち 4 件を提示)

質問: 報告書の提出期限はいつですか?
--- answer: 報告書の提出期限は今月の20日です。
```

`expected.accept = ["25日"]` は digest に実在する（層2は真）。**それでも実際の回答は
撤回済みの `20日`（`expected.reject`）だった**（層3は偽——ADR 0233 が見つけた自然発生の
fail）。⟹ **層2が真でも層3が真とは限らない**という `docs/autonomy.md` §2.2 の主張を、
作り物のケースではなく**実際に記録された1件**で再確認できる。

## 決めたこと

### 決定1: 層2の指標を、実ケース集合に配線する決定的な純関数として独立モジュールに置く

`examples/chat/src/answer-content-preservation.ts` に `checkContentPreserved(serializedPrompt,
expected)` を新設した。

- **LLM を呼ばない・DB を呼ばない。** `serializePromptSpec` の出力（モデルへ実際に渡す
  文字列。`answer-bench.ts` が既に計算している）と、ケースが既に持つ
  `expected.accept`（`gradeAnswer` と同じ正解データ、新しい正解を書き足さない）だけを見る。
- `expected.kind === "closed-value"` のとき、`accept` のいずれか1つでも
  （`normalizeForGrading` で正規化した上で）部分文字列として含まれれば `preserved: true`。
- `expected.kind === "must-abstain"` のとき、会話に保持すべき事実自体が無いため
  `applicable: false`（`preserved` は `true` を返すが、呼び出し側は `applicable` を
  先に見る契約——型ではなく docstring と歯で強制する）。
- `expected.reject` は見ない——「紛らわしい情報が混ざっているか」は層3の関心事であり、
  層2は「答えに要る情報があるか」だけを見る（上記 `schedule-change-deadline` の実例が、
  この分離がなぜ必要かを裏づける）。

### 決定2: `AnswerPathMeasurement`/`AnswerPathJson`/`AnswerRunJson` にケースごとの欄として足す

`answer-bench.ts` の `runAnswerCase` で naive/mnemora それぞれについて計算し、
`AnswerPathMeasurement.contentPreservation` として持たせた。`answer-json.ts` の
`AnswerPathJson`（ケースごと）と `AnswerRunJson`（トップレベルの集計、`applicable`/
`preserved` の件数）に伝播し、`schemaVersion` を 2→3 に上げた（既存の 1→2 と同じ理由——
「この形が変わったら上げる」という宣言に従う、追加のみの非破壊変更）。
`answer-format.ts` に `formatAnswerContentPreservation`（1行サマリ）を足し、`cli.ts` の
`runAnswer`/`recordAnswer` 両方の出力へ差し込んだ。

**`qualityClaimable`（`answerQualityClaimable(llmMode)`）に関係なく常に計算・出力する**。
理由: 層2は回答モデルの意味的な質ではなく、抽出/検索が組み立てた入力の性質を測る
——`deterministic` の下でも計算そのものは無害であり（純関数）、`deterministic` の
digest は本物の要約ではなく truncate された生発話であることは、この関数自身の
docstring と `answer-bench.postgres.test.ts` の追加コメントで正直に書いた。

### 決定3: 固定条件の回帰検査を、新しい CI ジョブを作らずに既存の2ジョブへ足す

- **`examples/chat/src/__tests__/answer-content-preservation.test.ts`**（新設、DB 不要・
  LLM 不要）。単体試験に加え、実ケース集合（dev + eval、`ANSWER_CASE_SET_DEV`/
  `ANSWER_CASE_SET_EVAL`）の全 closed-value ケースについて、**naive 経路は
  `buildNaiveAnswerPromptSpec`（`recall()` に依らない純関数）だけで常に
  `preserved: true` になる**ことを固定し、さらに**同一出典（`memoryId` を固定した
  `RecallResult`）のまま `digest` を各ケースの根拠ターン文面 → 汎用の情報欠落文言へ
  差し替える変異**で `preserved: false`（赤）になり、復元すると `preserved: true`
  （緑）に戻ることを、**5類 × dev の全 closed-value ケース**で固定した（ADR 0236 は
  1個の作り物のケースだけだった——ここでは実ケースの `grounds`/`expected.accept` を
  そのまま流用し、新しい正解データを書き足していない）。このファイルは
  `*.postgres.test.ts` ではないため、DB 不要な通常の vitest として走り、**ルートの
  `test` 門・`examples/chat` の通常テスト実行の両方で毎回走る**（既存の6つの門の1つ、
  ADR 0195）——新しい CI ジョブは作っていない。
- **`examples/chat/src/__tests__/answer-cli.postgres.test.ts`**（既存、`recorded` で
  実際に CLI を子プロセス起動し記録済みカセットを再生する歯）に、closed-value の
  全ケースについて `mnemora.contentPreservation.preserved === true` を固定する
  アサーションを追加した。**この歯は録り直しを要求しない**——上記「カセットの現物確認」
  で示したとおり、現在のカセットが既にこの性質を満たしている。この歯は
  `example-chat` ジョブの `test:db` ステップ経由で CI（required status check）に
  接続済みであり、新しいジョブは作っていない。
- **`answer-bench.postgres.test.ts`**（`deterministic`・配線検査）には、`contentPreservation`
  欄の**形**（`boolean`/`boolean`/配列）だけを固定するアサーションを足した。naive 側は
  値も固定した（ケース authoring の歯として——`deterministic` でも naive は全文を
  そのまま含むため）。mnemora 側の**値**は固定していない——`deterministic` の
  recall() 選定結果をこの ADR の作業者は実 DB で検証していない（下記「確かめていないこと」）。

### 決定4: `compare` の `factStatementSurvived` は変えない

`examples/chat/src/compare.ts`/`compare-json.ts`/`provenance-trace.ts` は1バイトも
変更していない。層2の指標は `answer` 側だけに足した——ADR 0226「採らなかった案」2番目
（「情報保持を測る新しい欄を `ComparisonRow`/`CompareRowJson` に足す」）が示した
「測る手段（`answer` のような、全文経路との対比器）が無いまま欄だけ足しても意味が無い」
という判断は、この ADR で `answer` 側にその手段ができた後もなお `compare` 側には
適用していない——`compare` は単一の事実表明・単一シナリオ（`scenario.ts` の
`FACT_STATEMENT`）用の器であり、ケースごとの `expected.accept` を持たない
（ADR 0146）。`compare` へ拡張するかどうかは、この ADR の範囲外の判断として残す。

## 採らなかった案

- **⛔ 層2の指標を LLM 採点（judge）で作る。** 却下。`docs/autonomy.md` §2.2 決定5
  「別の AI が採点したという理由だけで、正解の根拠や独立性が確保されたと見なさない」
  および Issue #498「LLM 採点だけを正解にしない」に反する。決定的な部分文字列一致の方が、
  弱くても独立した第二の物差しになる。
- **⛔ 層2の指標を `digest` の長さや非空性だけで近似する。** 却下——この ADR の
  変異試験そのものが、この近似（本 ADR の作業中に実際に実装して赤くした「変異(b)」
  「変異(c)」、下記「証明する範囲」参照）を捕まえることを確認している。
- **⛔ `sourceObservationId`/`memoryId` の一致（層1）を層2の代わりに使う。** 却下——
  ADR 0226/0236 がまさにこの誤りを指摘した対象であり、この ADR の変異試験の
  「変異(a)」がこれを模した実装（常に `true`）を実際に赤くした。
- **⛔ 実 API で変異後の回答生成プロンプトを記録し直し、層2と同時に層3側の陽性対照も
  作る。** 却下（今回は）。Issue #498 が既に「鍵は頼み直さない、オーナーへ諮る」形で
  この残作業の住所を確定させている——この ADR はその判断を上書きしない。重複した
  子 Issue も作らない（下記「#498 との関係」）。
- **⛔ `compare` にも同じ層2の指標を足す。** 却下（今回は）。`compare` は
  ケースごとの正解データを持たない単一シナリオの器であり、`expected.accept` に相当する
  ものが無い。拡張には別の設計判断（`compare` のシナリオをケース集合化するか）が要り、
  この ADR の範囲を超える。
- **⛔ `schemaVersion` を上げない。** 却下——`answer-json.ts` の `schemaVersion` の
  docstring 自身が「1→2」を追加のみの変更に対して上げた先例を持ち、同じ規約に従う
  ほうが読み手の期待と一致する。

## 証明する範囲

- ⭕ **示すもの**: `checkContentPreserved` が実際に噛むこと——**3種の「やりすぎた実装」
  （変異(a) 常に `preserved: true`／変異(b) digest が非空なら `preserved: true`／
  変異(c) `reject` の不在だけを見る）を一時的に実装へ当て、`answer-content-preservation.test.ts`
  の26件のうち7件（変異(a)(b)）・20件（変異(c)）がそれぞれ赤くなることを実測し、
  元の実装に戻して26件全部が緑に戻ることを確認した**（コミットには含めていない——
  `docs/autonomy.md` の変異試験の作法どおり、一時的に当てて記録し、`cp`/`diff` で
  復元・検証した）。
- ⭕ **示すもの**: 実ケース集合（dev、5類の closed-value 全件）に対する変異
  ——同一 `memoryId` のまま digest を根拠ターン文面 → 汎用の情報欠落文言へ差し替えると
  `preserved: false`（赤）、復元すると `preserved: true`（緑）。
- ⭕ **示すもの**: 記録済みカセット（2026-09-17、gpt-4o-mini/text-embedding-3-small）の
  再生において、closed-value の全10ケースで、mnemora 経路の digest に `expected.accept`
  が実在すること（`answer-cli.postgres.test.ts` の新しいアサーション。CI 実行はこの
  PR の push 後に確認する——下記「確かめていないこと」）。
- ⛔ **示さないもの**: 層3（回答評価、judge/`gradeAnswer` が同じ変異を検出できること）。
  これは Issue #498 の既存の未達のまま——鍵の判断待ちであり、この ADR は重複させない。
- ⛔ **示さないもの**: `deterministic` モードでの mnemora 経路の `contentPreservation` の
  値そのもの（`answer-bench.postgres.test.ts` は形だけを固定した——本物の Postgres が
  この作業環境に無く、実行して確認していない）。

## 確かめていないこと

- **`*.postgres.test.ts`（`answer-bench.postgres.test.ts`/`answer-cli.postgres.test.ts`）
  を、この作業環境で実際に実行していない。** `DATABASE_URL` が無く、`docker`も使えない
  （このセッションの作業環境）。追加したアサーションが実際に緑になるかは、この PR の
  CI（`example-chat` ジョブ、`test:db` ステップ）で初めて確認される。
- **`answer-cli.postgres.test.ts` に足したアサーションの根拠**（カセットの digest 文字列）
  は `node -e` でカセット JSON を直接読んで確認した【実測】が、**それが実際に
  `runAnswerCase`/`buildMnemoraPrompt` の実行結果と1バイトも変わらず一致するか**は、
  CI がこの PR を実行して初めて確定する（カセットは記録済みの LLM/embedding 応答の
  再生であり、`recall()` 自体は本物のコードが走るため、理論上は一致するはずだが、
  この ADR の作業者は自分の手で `answer` CLI を実行して確認してはいない）。
- **層3（回答評価）側の陽性対照**は Issue #498 の未達のまま、鍵の判断待ちである。
- **`compare` へ同種の指標を広げる価値**は検討していない（「採らなかった案」参照）。
- **カセットの鮮度**: 記録は2026-09-17、この ADR の作業は2026-09-25——8日経過している。
  古さの許容基準は repo に明文化されたものを見つけていない。実害（記録と実 API の乖離）は
  `verify:answer`（README 記載）で測れるが、この作業環境には鍵が無く実行していない。

## これが覆るとしたら

- **層3側の陽性対照が実 API の記録追加で着地したとき**（Issue #498 が既に用意した
  合流点）——`checkContentPreserved` はそのまま使い回せる設計にしてある
  （`serializedPrompt`/`expected` だけを受け取る、実行経路に依らない純関数）。
- **`compare` 側にもケースごとの正解データを持つ拡張が入ったとき**——「採らなかった案」
  の最後の項目を再検討できる。
- **この指標の部分文字列一致が、実際の運用で偽陰性（意味的には保持されているが
  `accept` の言い回しと一致しない）を多発させたと分かったとき**——`answer-content-preservation.ts`
  の docstring「確かめていないこと」に既に書いてある限界が実害化した場合、判定方式の
  見直しが要る。

## #498 との関係

この ADR・Issue #693 は #498 の子であり、#498 が既に確定させた「層3側の陽性対照は
鍵の判断待ちで#498側に残す」という判断を上書きしない。新しい子 Issue は作らない
（#498 自身が「新しい子 Issue は立てない」という方針を既に採っている——Issue #498
2026-09-17コメント「⛔ 新しい子 Issue は立てません」）。#693 が閉じても #498 は
層3側の未達ゆえ閉じない。

## 人から受け取った前提（出所付き）

- 本 ADR が採る方針の骨子（層2の指標を作る・出典到達の意味は変えない・LLM 採点だけを
  正解にしない・鍵待ちの残作業を重複させない）は、この作業を委譲した側からの委譲文として
  受け取った。この ADR の作業者が独自に導出したものではない。
- Issue #693 / #498 の本文・コメント——`gh issue view` で直接読んだ【現物】。
- ADR 0052 / 0224 / 0226 / 0233 / 0236 / 0220 / 0295 の内容——`docs/decisions/` から
  直接読んだ【現物】。
- カセットの分類・digest の内容——この ADR の作業者が `node -e` で独立に読んで
  確認した【実測】。
- 変異試験（3種の「やりすぎた実装」が実際に赤くなること）——この ADR の作業者が
  実際に一時的な実装差し替えと `vitest run` で確認した【実測】。
- **DB を要する検査**（`examples/chat` の `*.postgres.test.ts`）は、この作業環境に
  `DATABASE_URL`・`docker` のどちらも無いため実行していない。PR 本文参照。
