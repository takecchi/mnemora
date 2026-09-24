# ADR 0297: 完了条件4「回答評価」側の陽性対照を実 API で記録し、カセット再生の歯として固定する（Issue #498）

- **状態**: 提案（本 PR の作業内容の記録。マージ判断・ADR 番号の最終確定はオーナー/マネージャーが行う）
- **日付**: 2026-09-24

**⚠ 各主張の出所を分ける**（ADR 0233 / 0236 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 委譲文として受け取り、この ADR の作業者が再導出していない。

⚠ **番号について**: `git fetch` 直後の origin/main の ADR 最大番号は `0294`。PR #698 が
`0295`、PR #699 が `0296` を仮取り済み（いずれも未マージ、2026-09-25 時点）だったため、
衝突を避けて `0297` とした。**マージ時に、その時点の状況に応じて番号を振り直すこと**
（`scripts/adr-renumber.mjs` の対象）。

---

## 文脈

Issue #498 完了条件4「同じ出典のまま答えの情報を欠落させた場合に、内容保持または
回答評価が失敗することを確認する」は選言であり、ADR 0236（PR #523）が「内容保持」
（層2）側だけを fake `MemoryStore` を使う単体試験で満たし、「回答評価」（層3、
`gradeAnswer`/judge が実際に赤くなること）は**実 API での記録の追加を要する**として
未達のまま残した。

Issue #498 の最新コメント（2026-09-18、担当: 自動化された担い手）は、この残作業を
「鍵と課金の判断はオーナーのものである」として保留し、オーナーへ諮る形にしていた。
**本 PR は、その判断が下りた後（鍵を渡されたセッションから）着手したものである**——
本 ADR の作業者はその判断が下った経緯そのものには関与していない（【受】）。

## 決めたこと

### 決定1: 既存カセット67件は1バイトも録り直さず、変異分2件だけを実 API で追記する

`docs/autonomy.md` §2.2 決定4「カセットの更新も、単なる録り直しで評価の変化を隠さない」
に従う。`examples/chat/src/cli.ts` の `recordAnswer`（＝ `record answer`）は毎回**空の**
`CassetteRecorder` から全12ケース×2経路を録り直す全置換であり、これをそのまま実行すると
既存67件も実 API で録り直されてしまう。

⟹ **既存カセットを丸ごと `CassetteRecorder` へ事前投入し**（`recordLLM`/`recordEmbedding`
を既存エントリぶんだけ先に呼んでおく）、`RecordingLLMProvider`/`RecordingEmbeddingProvider`
の「既に記録済みの鍵は委譲先を呼ばない」という既存の挙動（ADR 0233 決定1）を利用して、
既存67件ぶんの呼び出しを一切実 API へ送らないようにした
（`examples/chat/src/scripts/record-answer-retention-mutation.ts`）。

**【実測】既存67件は事前投入だけで完走し、実 API 呼び出しは0回だった**——スクリプトが
`recorder.llmCount`/`embeddingCount` の前後比較でこれを検査し、0件でなければ落ちる形に
してある。`git diff examples/chat/cassettes/answer.json` は `recordedAt` の更新と、
末尾に追加された2件の新規エントリだけを示し、既存エントリの値（`JSON.stringify` での
深い比較）は変わっていないことを `node -e` で確認した。

⚠ **`saveCassette` は素の `JSON.stringify(cassette, null, 2)` を書くが、既存ファイルは
prettier（`printWidth: 100`）で整形済みだった。** 気づかずに書き出すと、配列の折り方が
変わって10,000行超の無関係な整形差分が出る（実際に一度踏んだ）。⟹ **書き出し後に
`npx prettier --write` を通すことを、スクリプトの docstring と本 ADR に明記する。**

### 決定2: 変異は `PromptSpec` の文字列に対して行う。`RecallResult`/DB には触れない

対象ケースは `pref-tea-over-coffee`（`answer-case-set.dev.ts`、development 用、既存の
`expected`/`grounds` は1文字も変更していない）。`examples/chat/src/answer-retention-mutation.ts`
の `applyRetentionMutation(promptSpec)` が、本物の `ingestConversation`/`queryRecall`
（本物の Postgres + pgvector、記録済みの抽出・埋め込みを通した実行経路）が実際に組み立てた
mnemora 側 `PromptSpec.messages[0].content` から、答えの語を含む部分文字列
（`"打ち合わせのとき、飲み物はコーヒーより紅茶のほうが好き"`）を、要約失敗を模した文言
（`"[要約失敗。内容は保持していません]"`。ADR 0236 の単体試験と同じ体裁の言い回しを意図的に
揃えた）へ置き換える。

**なぜ `RecallResult`（`recall.memories[].digest`）ではなく `PromptSpec` の文字列を
変異させるのか**: `resultContainsObservation`（層1・出典到達）は `Memory.sourceObservationId`
を Postgres から読むだけで、`digest` の中身も `PromptSpec` の中身も一切見ない
（`provenance-trace.ts`、ADR 0236 が既に固定した事実）。⟹ `PromptSpec` の文字列だけを
書き換えても、`sourceObservationId` は Postgres の行としてまったく触れられておらず、
同じ出典を指したままである。層1 そのものの再検査は ADR 0236 / PR #523 が既に固定して
おり、本 PR では測り直さない——本 PR が固定するのは「その出典到達が変わらない前提のまま、
層3（回答評価）が実際に崩れること」だけである。

### 決定3: 変異の定義を1箇所（`answer-retention-mutation.ts`）に集約し、記録側・再生側・
`record answer` 経路の3箇所から同じ関数を呼ぶ

`applyRetentionMutation`（変異そのもの）と `recordRetentionMutationPositiveControl`
（変異後の回答生成＋judge を実行する手順）を同モジュールに置き、次の3箇所が同じ関数を呼ぶ:

1. `examples/chat/src/scripts/record-answer-retention-mutation.ts`
   ——既存カセットへの**追記専用**の記録スクリプト（決定1）。
2. `examples/chat/src/cli.ts` の `recordAnswer`
   ——`runAnswerBench` の直後に `recordRetentionMutationPositiveControl` を呼ぶ
   （下記決定4）。
3. `examples/chat/src/__tests__/answer-retention-positive-control.postgres.test.ts`
   ——カセット再生の歯（下記「歯」節）。

変異のロジックを複数箇所に書き写すと、どちらかを直し忘れたときに「記録した変異」と
「検査している変異」が静かにずれる——`answer-bench.ts` の `buildNaiveAnswerPromptSpec`
を `answer-bench.ts`/`cassette-coverage.test.ts` の両方が呼ぶのと同じ規律（ADR 0233
決定4）に倣った。

### 決定4: `recordAnswer`（`record answer`）自身に組み込み、全置換の録り直しでも
変異分が自動的に付いてくるようにする

**当初案（別スクリプトだけに変異を置く）を採らなかった。** 理由: `record answer` は
毎回全置換であり、Issue #691（PR #698）・Issue #693（PR #699）が近く
`examples/chat/cassettes/answer.json` を全体で録り直す予定であることが分かっている
（マネージャーからの伝達。本 ADR の作業者は直接確認していない——【受】）。変異が
`record answer` の経路の外（別スクリプトだけ）にあると、次に誰かが素の `record answer`
を走らせて全置換した瞬間に、この変異分の2エントリだけが新しいカセットから消える。

⟹ **`cli.ts` の `recordAnswer` が `runAnswerBench` の直後に
`recordRetentionMutationPositiveControl` を呼ぶよう組み込んだ。** 以後どんな
`record answer` の実行でも、変異分（chat 2回・埋め込み0回・追加費用 $0.0001 未満）が
自動的に含まれる。

⚠ **決定1 の追記専用スクリプトは冗長ではなく、残してある。**
`recordAnswer`（`record answer`）は全12ケース×2経路を録り直す全置換（約 $0.003、
Issue #498 の見積もり）であり、**変異分だけを最小コストで既存カセットに追記したい**
という本 PR の実際のニーズ（既存67件を録り直さない）には応えない。両者は用途が違う
——決定1 のスクリプトは「今回のように、既存カセットへ変異だけを足したいとき」、
決定4 の組み込みは「いずれ誰かが `record answer` を全置換で走らせたとき、変異が
自動的に付いてくるようにする保険」である。

#### 🔴 ファイルレベルの衝突の可能性（正直に書く）

**PR #699（Issue #693）が、本 PR と同じ2ファイル（`examples/chat/src/cli.ts` /
`examples/chat/src/answer-bench.ts`）を別の目的（層2「内容保持」指標の配線）で
変更中である**（2026-09-25 時点、未マージ）。PR #699 は `answer.json` には触れておらず、
`recordAnswer` の変異呼び出し部分とも意味的には重ならない（PR #699 は `runAnswerBench`
の**結果**に `contentPreservation` 欄を足す側、本 PR は `runAnswerBench` の**直後に
別の呼び出しを1本足す**側）が、同じファイルの近い行を触るため、**どちらかが先に
マージされた後、もう片方は `cli.ts` の単純な rebase を要する可能性が高い。** マージ判断・
rebase の実施はマネージャー/オーナーに委ねる。

### 決定5: 一次判定・二次観測ともに、実測した具体的な値をそのまま固定する
（`indeterminate` へ丸めない）

再生側の歯（`__tests__/answer-retention-positive-control.postgres.test.ts`）は
`mutatedVerdict`/`mutatedJudgement.outcome` を `"fail"` に固定している——
`.not.toBe("pass")` のような緩いアサーションにしていない。理由:
`docs/autonomy.md` §2.2 決定5 は「実測を見て期待を書き換えない」ことを求めるが、
これは事前に期待を弱く書いておいて後から確かめる、という順序を正当化しない。
**【実測 2026-09-24、`gpt-4o-mini`】記録した実際の値はどちらも `"fail"`**
（一次: 答えの語を失った digest から回答生成した結果は「分かりません。」であり、
`accept`/`reject` のどちらにも一致しないため `gradeAnswer` は `"fail"`。二次:
judge は「質問に対する具体的な答えを示していない。」として `FAIL` と判定した）。
この観測された値をそのまま歯に焼き込んだ。

## 実 API の記録【実測】

- **呼び出し回数**: `chat.completions.create` **2回**（`gpt-4o-mini`）。
  `embeddings.create` **0回**。
- **トークン**: `prompt_tokens=488` / `completion_tokens=29`（usage-meter の実測）。
- **費用（公開価格表による概算。実額ではない）**: LLM input $0.000073 / LLM output
  $0.000017 / embedding $0.000000 / **合計 $0.000091**。予算上限 $0.05 に対して
  十分小さい。
- 呼び出し前にコード上で回数を確定させた
  （`examples/chat/src/scripts/record-answer-retention-mutation.ts` の docstring）
  ——「変異後の回答生成1回＋judge 1回＝2回、embeddings 0回」という見積もりと、
  実測の呼び出し回数は完全に一致した。

## 歯

`examples/chat/src/__tests__/answer-retention-positive-control.postgres.test.ts`
（本物の Postgres + pgvector、`MNEMORA_LLM=recorded`/`MNEMORA_EMBEDDING=recorded`。
鍵は要らない）:

1. 変異前（＝復元後と同じ内容）: 一次判定 `pass` / 二次観測 `pass` / 突き合わせ `pass`。
2. 変異後: 一次判定 `fail` / 二次観測 `fail`（決定5）。
3. 復元: 変異前と同じ `PromptSpec` に戻すと `pass`/`pass` に戻る。

**【実測】歯が実際に噛むことを、意図的に壊して確認した**——3番目のブロックで使う
`applyRetentionMutation` の呼び出しを一時的に外し（＝変異を入れずに `mutatedVerdict`/
`mutatedJudgement.outcome` を `"fail"` と assert する形のまま）実行したところ、
`AssertionError: expected 'pass' to be 'fail'` で赤くなることを確認した。その後 `cp`
で元に戻し（`docs/autonomy.md` の変異を戻す作法に倣い `git checkout` は使わず `cp` で
退避・復元）、緑に戻ることを確認した。

## 完了条件4 の判定

| 側 | 状態 |
|---|---|
| 内容保持（層2） | ✅ ADR 0236 / PR #523 で既に満たしている（本 PR は変更していない） |
| **回答評価（層3）** | ✅ **本 PR が満たした**——同じ出典（`sourceObservationId` を
  変更しない設計、決定2）のまま、実際の回答生成・judge を実 API で走らせ、変異で赤、
  復元で緑になることを、カセット再生で回る歯として固定した |

⟹ Issue #498 完了条件4 は選言のどちらの側も満たされた。ただし **#498 自体を
閉じるかどうかは、完了条件7本全体の再照合を要し、本 PR の作業者は行っていない
——判定はマネージャー/オーナーに委ねる。**

## 確かめていないこと

- **`gradeAnswer`/judge の偽陽性・偽陰性率**（ADR 0233 が既に「確かめていない」と
  名乗っていたもの）。本 PR は1ケースの陽性対照を1回記録しただけであり、
  検出力の一般的な measurement ではない。
- **他の5類（schedule-change / negation / other-person / other-period / unknown）に
  同種の変異を当てたときの挙動。** 本 PR は `preference` 類（`pref-tea-over-coffee`）
  1件だけを対象にした——設計コメント §7 が要求する「1ケースの陽性対照」を満たす
  最小の範囲であり、全類を尽くすことは求められていない。
- **`verify:answer`（記録と実 API の乖離）は本 PR の作業時点で未実行**
  （鍵はあったが、乖離測定は別の関心事であり、本 PR の範囲外とした）。
- **PR #698 / #699 との rebase 後の実際の conflict 解消結果。** 決定4 の節に書いた
  ファイルレベルの重なりが、実際にどう解消されるかはマージ時にしか分からない。

## 採らなかった案

- **⛔ (a) 変異を `RecallResult`（`recall.memories[].digest`）に対して行う。** 却下
  ——`buildMnemoraPrompt` は `mnemora-path.ts` にあり、Issue #691（PR #698）が
  まさにそのファイルを変更中である。触れずに済む決定2の方式（`PromptSpec` の文字列を
  直接変異させる）を採った。
- **⛔ (b) 既存カセットを全置換で録り直す。** 却下——`docs/autonomy.md` §2.2 決定4、
  および Issue #498 の最新コメントが「変異後のプロンプトも記録対象へ含める」以上を
  要求していない。既存の67件・過去の実測（ADR 0233）の数字を動かす理由が無い。
- **⛔ (c) 複数ケース・複数類に変異を広げる。** 却下（今回は）——設計コメント §7 が
  求める最小限は1ケースの陽性対照であり、鍵の使用は最小限に留めるべきという
  Issue #498 のこれまでの姿勢（「頼み直すには強い理由が要る」）を踏まえ、1ケースに
  絞った。範囲を広げる価値があるかどうかはオーナー/マネージャーの判断に委ねる。

## これが覆るとしたら

- **PR #698 / #699 のどちらかが先にマージされ、`cli.ts`/`answer-bench.ts` の形が
  変わったとき。** 本 PR は rebase を要する可能性が高い（決定4 参照）。
- **`gradeAnswer`/judge の偽陽性・偽陰性率が測定され、この1ケースの陽性対照だけでは
  不十分だと判明したとき。**

## 人から受け取った前提（出所付き）

- PR #698（Issue #691）が `examples/chat/src/mnemora-path.ts` と
  `examples/chat/src/__tests__/provenance-trace.test.ts` を変更中であり、触れるべきで
  ないという情報——マネージャーからの伝達（【受】）。`gh pr list` で本 PR の作業者も
  独立に確認した（【実測】）。
- Issue #691（PR #698）・Issue #693（PR #699）が近く `answer.json` を全体で録り直す
  予定であるという情報——マネージャーからの伝達（【受】）。本 PR の作業者は両 Issue の
  本文を直接読んでいない。
- Issue #498 のコメント履歴・ADR 0233/0236 の内容——`gh issue view`/`docs/decisions/`
  から直接読んだ（【現物】）。
