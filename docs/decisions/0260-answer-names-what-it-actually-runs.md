# ADR 0260: `answer` が「記録した応答を再生する」と名乗りながら擬似 provider で走るのをやめる —— 名乗る関数と実態を倒す関数を1つにし、使われなかったカセットを出力に焼く（Issue #577）

- **状態**: 提案 (2026-09-21)
- **日付**: 2026-09-21

**⚠ この ADR を書いたのは、自動化された担い手（クローンのマネージャーのセッション）である。**
**⛔ コミット・PR の作者欄の `takecchi` は「オーナー本人が書いた」を意味しない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナー本人は、この決定の方針（下記「決めたこと」の全体）を承認している**——⛔ **ただし本文の逐語を読んではいない。**

**⚠ 各主張の出所を分ける**（ADR 0068 / 0257 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — 書き手が自分の手で `git` / `grep` / `gh api` を走らせて確かめた。
- **【受】** — Issue #577 / PR #575 の記録として受け取り、再導出していない。
- **【推論・未検算】** — コード読解から導いたが、**走らせて確かめていない。**

**この ADR の観測基準 【実測】**: `origin/main = 4944046`（2026-09-21T09:24:39+09:00）。
**⛔ 実 API は1回も叩いていない。⛔ この ADR のために DB を立てた測定は1つも行っていない**——下記「確かめていないこと」を見ること。

---

## 文脈 —— 画面は嘘をついたのではない。**自分と矛盾していた**

[Issue #577](https://github.com/takecchi/mnemora/issues/577) は、`examples/chat` の `answer` を鍵なし・モード無指定で走らせると、画面が「記録した応答を再生する」と名乗り、カセットの中身（67件・39件）まで出しながら、実際には `deterministic` の擬似 provider で走ることを報告した【受】。

**⭐ しかし現物は、Issue の記述より1段深い形をしていた**【現物】。**同じ画面に、真実も一緒に出ている。**

| 画面の行 | 出所 | 性質 |
|---|---|---|
| `[cassette] 記録した応答を再生する: …67件…39件` | `cli.ts` の `resolveCassetteForRun`（改名前） | **provider 構築の *前*。** ファイルが在ることから導いた**予告** |
| `[provider] LLM       : @mnemora/testkit の決定的な擬似 provider` | `printProviderMode`、`handle.llmMode` から | **構築の *後*。** 実際に組まれた provider の**実測** |

`runAnswer` は `printProviderMode(handle.llmMode, handle.embeddingMode)` を**ちゃんと呼んでいた**【現物】。Issue 本文が貼った実行ログにも両方写っている。

⟹ 🔴 **[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定5（名乗れないものを名乗らない）に照らしたときの罪は「嘘をついた」ではなく、「*まだ測っていないこと* を、実測と同じ口調で名乗った」である。**

⟹ ⭐⭐ **これは決定5 の「名乗れない」に *まだ測っていない* が含まれることを示す、現物の実例である。**[ADR 0255](./0255-tools-output-candidates-not-verdicts.md) が `AGENTS.md` へ成文化した節は「取りこぼしがゼロにならない道具」を宛先にしていたが、**同じ規律は「実行前に立てた見込みを、実行後の事実として出す」形にも当たる。**

### ⛔ これは規律違反ではない

🔴 **`runAnswer` の実装は、決定5 の成文化（[PR #569](https://github.com/takecchi/mnemora/pull/569)、ADR 0255。マージ `2026-09-20T21:19:46Z`【実測】）より前から在る。**
⟹ **「違反」ではなく「成文化した規律が、着地と同時に当たった既存の実装」である。**⛔ **遡って違反と呼ばない。**

---

## 測ったこと 【現物】—— 落ちたのは1本。**そして偶然ではない**

### 1. カセットを解決する口は3つあり、env を倒すのは2つだけだった

`resolveCassetteForRun`（改名前）の呼び出しは cli.ts に3箇所【実測。識別子全体を検索し、対照として `run*` 関数が15本引けることを確認した】。

| 呼び出し | provider に渡していた env |
|---|---|
| `runCompare` | **倒す**（`{ ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" }`） |
| `runRetrieval` | **倒す**（`buildArmSpecs` が arm ごとに上書き） |
| `runAnswer` | ⛔ **倒さない**（`process.env` を素通し） |

### 2. 🔴 なぜ3本目が落ちたか —— **配線が構造で強制されていなかった**

**`createProviders` は `decideProviderSource` を一度も呼ばない**【現物】。
⟹ `MNEMORA_PROVIDER_SOURCE` は「カセットを**読むか**」しか決めず、「provider が**何で構築されるか**」には一切効かない（`selectProviderMode` / `selectLLMMode` はこの変数を読まない）。
⟹ 🔴 **「名乗ったら倒す」は、注意書きと同格の規律だった。型も構造も、それを強制していない。**

⟹ ⭐⭐ **だから3箇所目が落ちたのは、書いた人の不注意ではない。** [ADR 0068](./0068-the-bench-must-not-lie-about-what-it-measured.md) が同じことを逐語で言っている:

> **⟹ これは個人の不注意として片付けてはいけない。** … **だから本 ADR は、注意書きではなく出力の形を変える。**
> **⛔ 注意書きは足さない。注意書きは検査されない。形で塞ぐ。**

そして `createProviders` は、`llmMode !== "recorded"` のとき**渡されたカセットを黙って捨てる**【現物】。

### 3. `runAnswer` の docstring は、現物と食い違っていた

逐語【現物】: 「**provider は `compare`/`retrieval` と同じ規律**」。⛔ **同じ規律ではなかった。** これが本 ADR の直前まで残っていた。

### 4. 既定の道は、どの歯も通っていなかった

`answer` の歯は4本【現物】。`answer-cli.postgres.test.ts`（[PR #575](https://github.com/takecchi/mnemora/pull/575) が足した）だけが本物の CLI を子プロセスで起動するが、**env を明示指定して欠陥を迂回している。** ⭐ **同ファイルのコメントが、この欠陥を逐語で説明している**【現物】——**歯は、欠陥を知った上で避けていた。**

### 5. ⚠ 「CI は `answer` を一度も走らせていない」は、字面では真・実行としては偽

Issue #577 の見出しの主張である【受】。`.github/workflows/` 全体に `answer` は **0件**、対照として `compare` は **24件**【実測】——**grep は機能している。**
⛔ **だが `example-chat` job の `test:db` が `answer-cli.postgres.test.ts` を走らせ、それが子プロセスで `pnpm run answer` を2回起動する**【現物】。**yml に現れない間接呼び出しである。**

⟹ ⭐ **そして `required_status_checks.contexts`（6本）には `examples/chat (本物の Postgres + pgvector、擬似 provider)` が既に入っている**【実測、`gh api repos/takecchi/mnemora/branches/main/protection`】。
⟹ 🔴 **既定の道の歯を既存の `test:db` へ足せば、それは自動的に required になる。新しい job も新しい required 設定も要らない。**
⟹ ⚠ [Issue #426](https://github.com/takecchi/mnemora/issues/426) が立てた「測定ジョブを足しても `required_status_checks` に入らなければ止まらない」という問いは、**新しい job を作る場合にしか立たない。**

---

## 決めたこと

### 決定1. 名乗る関数と env を倒す関数を、1つの値にする —— `resolveRecordedRun`

`resolveCassetteForRun(target): Cassette | undefined` を **`resolveRecordedRun(target): RecordedRunPlan`** に改める。返すのは「カセット」ではなく「**この実行の形**」である:

- `env` —— provider を構築するときに渡す env。**カセットを読めたなら `MNEMORA_LLM` / `MNEMORA_EMBEDDING` を `"recorded"` へ倒してある。**
- `providerOptions` —— `createProviders` に渡す options。
- `cassette` —— 読めたカセット（`runRetrieval` が arm を組むために要る）。

⭐ **芯: カセットを受け取る唯一の経路が、倒した env を必ず一緒に返す。**
⟹ 🔴 **「名乗ったのに倒し忘れる」形が、書けなくなる。** 4箇所目を足す人は、倒さないためにわざわざ `plan.env` を捨てる必要がある。

⛔ **これは `runAnswer` に3行足すこと（Issue #577 の案 (あ)）ではない。** (あ) は3箇所目を直すが、**4箇所目を防がない。** 落ちた原因は書き忘れではなく構造だった（測ったこと2）。

### 決定2. 🔴 既定の `pnpm run answer` の出力の *意味* が変わる。これは意図した変更である

決定1 の結果、鍵なし・モード無指定の既定の実行が `deterministic` から `recorded` へ倒れる。⟹ **`answerQualityClaimable(llmMode) = llmMode !== "deterministic"`**【現物】が `false` → `true` に反転する。⟹ 画面と JSON が変わる:

- ⛔⛔⛔ **「これは配線の検査であり、回答品質は測っていない」バナーが消える**（`formatAnswerQualityBanner` が空文字を返す）
- 表の正誤・二次観測・突き合わせ列が `—` から ✅❌❓ になる
- `MNEMORA_ANSWER_JSON` に集計（pass / fail / indeterminate）が出るようになる

🔴 **これは副作用ではない。意図した変更である。小さく見せない。**

**なぜ許されるか——repo が既にそう決めているから。** `answerQualityClaimable` が `recorded` を `true` に含めているのは**そういう決定**であり、[ADR 0051](./0051-recorded-provider-cassette.md) が「北極星の物差しには**記録した対応表**を使う。実キー無しで**本物由来の数字**が出る」と決めたことの帰結である。⟹ **この ADR はその決定を覆していない。`answer` をその決定に *合流させている*。**

### 決定3. ⚠ ADR 0068 決定3 の逐語は字面では当たる。**守っている対象が違うと判断した**

ADR 0068 決定3 の逐語【現物】:

> **⛔ 既定の振る舞いは変えない。**「キーが在れば実 API」は誰かの意図かもしれない ——**能力を足すだけにする。**

🔴 **この文は字面では本 ADR に当たる。決定2 は既定の振る舞いを変えている。**
⟹ ⛔ **黙って通さない。外れたことを明記する。**

**外れてよいと判断した理由**: 0068 が守ろうとしたのは「**キーが在るとき実 API に行く**」という既定であり、そこには「利用者が課金を意図しているかもしれない」という取り返しのつかなさが在る。**本 ADR が変えるのは「鍵が無いときの倒れ先」であり、どちらに倒れても API は叩かれず、課金も起きない。**
⟹ ⭐ **そして `compare` / `retrieval` の「鍵が無いときの倒れ先」は、0068 の時点で既に `recorded` である。** `answer` だけが `deterministic` に残っていた。
⟹ **⛔ この判断は書き手（担い手）のものである。0068 の書き手にも、オーナー本人の逐語確認にも当てていない。**

### 決定4. ⭐ 「渡されたのに使われなかったカセット」を、**例外ではなく出力に焼く**

`Providers` に `cassetteIgnored: boolean` を足す（`options.cassette` が在り、かつ `llmMode` も `embeddingMode` も `"recorded"` でないとき `true`）。`printProviderMode` が `true` のとき1行足す。

**⛔ なぜ例外にしないか —— 正当な経路が実在するから**【現物】。
`runRetrieval` の **arm A**（`armLabel: "A: 擬似LLM+擬似埋め込み"`）は `llmOverride` / `embeddingOverride` とも `"deterministic"` で走るが、`runRetrieval` は**全 arm に同じカセットを渡す**。⟹ 🔴 **例外にすれば、いま正しく通っている対照 arm が即座に落ちる。**

⟹ ⭐⭐ **これは ADR 0051 `requireCassette` の鏡像だが、対称ではない。**

| 向き | 現物 | なぜその形か |
|---|---|---|
| `"recorded"` を指定したのにカセットが無い | **例外**（`requireCassette`、ADR 0051） | 続行すれば擬似物で走る。**致命的な食い違い** |
| カセットが在るのにどのモードも `"recorded"` でない | ⛔ **これまで沈黙。本 ADR で「出力に焼く」** | **正当な経路が実在する**（arm A）。例外にできない |

⟹ 🔴 **そして「例外にできないから諦める」ではない。ADR 0255 / ADR 0223 決定5 が言っているのはまさにこれである**——**判定（exit 非0・例外）にできないものは、出力に焼く。**

⭐ **`printProviderMode` の引数に畳み込む**（オプショナルにしない・既定値を持たせない）。⟹ **開示せずに provider バナーを出せなくする。** ADR 0068 の「形で塞ぐ」の適用である。

⚠ **これにより `retrieval` の arm A に新しい警告行が1行出るようになる。** ⭐ **これは望ましい**——run 全体の `[cassette] 記録した応答を再生する` が arm A まで再生したと読ませないためである。

### 決定5. docstring を現物に合わせる

`runAnswer` の docstring の「provider は `compare`/`retrieval` と同じ規律」は、決定1 の後は**本当にそうなる**。⟹ 文面を現物どおりに直す。
⛔ **ただしこれを単独の直し（Issue #577 の案 (う)）としては採らない。** 注意書きは検査されない（ADR 0068）。

### 決定6. 既定の道を歯で通す

`answer-cli.postgres.test.ts` に **`MNEMORA_*` を一切指定しない**ケースを足し、**画面が自分と矛盾しないこと**（`[cassette]` が再生を名乗るなら `[provider]` が擬似 provider と言わない）と `qualityClaimable === true` を固定する。
⟹ ⭐ **`example-chat` job は既に required なので、これで Issue #577 の完了条件②③が同時に閉じる**（測ったこと5）。

---

## 検討して採らなかった案

| 案 | 中身 | 落とした理由 |
|---|---|---|
| **(い)** 名乗りを条件付きにする | `[cassette]` の行を、倒した場合だけ出す | ⛔ **名乗れるはずのものを名乗らなくなる。** カセットは実在し、再生は可能である。決定5 は「名乗るな」ではなく「*名乗れないものを* 名乗るな」。⚠ **加えて**: 条件を入れるには「呼び出し側が倒すか」を関数に教える必要があり、⟹ **それを渡せるなら、同じ場所で倒せる**（＝決定1） |
| **(う)** docstring だけ直す | 最小 | ⛔ 画面のずれが残る。ADR 0068「注意書きは検査されない」 |
| **(え)** 食い違ったら例外を投げる | ADR 0068 が `MNEMORA_PROVIDER_SOURCE=openai` ＋鍵無しに採った形 | ⛔ **形が違う。** 0068 の例外は**利用者が不可能を要求した**場合。ここは**カセットが実在し再生が可能**である。⟹ **可能なことを拒むのは決定5 の趣旨から外れる。** 加えて、鍵なしの既定の道が例外で止まるのは `examples/chat` の入口として後退 |
| **(あ)** `runAnswer` に3行足して `runCompare` に揃える | Issue #577 の第一候補 | ⛔ **3箇所目は直るが4箇所目を防がない。** 原因は書き忘れではなく構造（測ったこと2）。⟹ 決定1 に含めて超えた |
| 決定4 を例外にする | `requireCassette` と対称にする | ⛔ **`runRetrieval` arm A が落ちる**（決定4）。⚠ **この経路が実在することは、決定する前に現物で当てた** |
| 決定4 を別 PR にする | 小さく刻む | ⛔ **「片側だけ塞がっている」という対称性の指摘が、2つの PR に割れる。** 決定1 が4箇所目を防ぎ、決定4 が「決定1 が壊れたとき鳴る」を担う。**対で意味を持つ** |

---

## 引き受けた負債

### 🔴 1. `runAnswer` の tenant に `runId` が入っていない —— **別 Issue [#583](https://github.com/takecchi/mnemora/issues/583) へ切った**

`runAnswer` は tenant を `answer-bench-<caseId>` の**固定文字列**で作る【現物】。対して `recordAnswer` は `runId` を含めており、その docstring は逐語で「**`tenantPrefix` に `runId` を含め、毎回新しいテナントにする**」と書いている【現物】。⟹ **`runAnswer` だけがこの規律から外れている。**

⚠ **【推論・未検算】** 決定2 で既定が `deterministic`（擬似 embedding）から `recorded`（256次元）へ倒れるため、**永続 DB に対して過去に `deterministic` で `answer` を走らせた利用者は、同じ tenant に別次元の記憶が残ったまま `recorded` で走ることになる。** ⟹ 想起結果が変わり、記録に無いプロンプトが組まれて `RecordedLLMProvider` が例外を投げうる（ADR 0051「記録に無い入力は例外にする」）。
⛔ **走らせて確かめていない。** ⛔ **決定2 がこれを顕在化させうることは事実だが、欠陥そのものは決定2 より前から在る。**

⟹ **別 Issue [#583](https://github.com/takecchi/mnemora/issues/583) に切った**（`docs/autonomy.md`「ついでに直すをしない」）。⛔ **PR 本文の負債記録だけで終わらせない。**

### 2. `MNEMORA_PROVIDER_SOURCE` が provider の構築に効かないこと自体は、直していない

測ったこと2 の構造（`createProviders` が `decideProviderSource` を読まない）は、本 ADR では**呼び出し側を1つの値に束ねる**ことで塞いだ。⛔ **下層の非対称そのものは残っている。**

### 3. `answer` には `compare` のような基準値突き合わせの門が無い

決定6 の歯は「画面が矛盾しないこと」「`qualityClaimable`」を固定するが、**数字そのものの回帰は見ていない。**

---

## これが覆るとしたら

- **カセットが既定の case set（dev 6件 + eval 6件 = 12件）を網羅しなくなったとき。** ⟹ 既定の `pnpm run answer` が例外で止まる。⚠ **そのときは決定2 を見直すのではなく、カセットを録り直すのが先である**（ADR 0051）。
- **`answer` の既定を「品質を主張しない配線検査」に戻したくなったとき。** ⟹ 決定2 を覆すことになる。⚠ **そのときは `answerQualityClaimable` の側（`recorded` を主張可能に含めている判断）を先に見ること。**
- **`runRetrieval` の arm A が無くなったとき。** ⟹ 決定4 を例外にできるようになる。

---

## 確かめたこと

- **【実測】** `resolveCassetteForRun` の呼び出しは3箇所（識別子全体を検索。対照: `run*` 関数15本が引ける）
- **【実測】** `.github/workflows/` の `answer` は0件（対照: `compare` 24件）
- **【実測】** `required_status_checks.contexts` 6本に `examples/chat (…)` が含まれる（`gh api`）
- **【実測】** PR #569（ADR 0255）は `2026-09-20T21:19:46Z` にマージ済み
- **【現物】** `answerQualityClaimable(llmMode) = llmMode !== "deterministic"`
- **【現物】** `runRetrieval` の arm A は `deterministic` 固定で、かつカセットを渡されている
- **【現物】** `runAnswer` は `printProviderMode` を呼んでいる（＝呼び忘れではない）
- **【受】** PR #575 が、明示指定の道で exit 0・12件キャッシュミス0・2回一致を実測している

## 確かめていないこと

- 🔴 **この ADR の書き手は、`answer` を1回も走らせていない。** DB を立てていない。**上の「画面が変わる」は、すべて現物の読解から導いた**【推論・未検算】。⟹ **実際の出力を確かめるのは CI の `example-chat` job（決定6 の歯）である。**
- 🔴 **「素の実行（`DATABASE_URL` だけ、`MNEMORA_PROVIDER_SOURCE` も無指定）でも同じ欠陥が出る」は【推論・未検算】である。** Issue #577 の再現は `MNEMORA_PROVIDER_SOURCE=recorded` を明示しており、**無指定の道は誰も走らせていない。** ⟹ `decideProviderSource` が鍵無しで `{source:"recorded", reason:"no-key"}` を返すというコード読解に基づく。**決定6 の歯が、これを初めて実行で当てる。**
- 🔴 **引き受けた負債1（tenant の `runId`）は【推論・未検算】である。** 例外が実際に起きることを確かめていない。
- **決定2 が既存の利用者の手元で何を壊すかは、測っていない。** `examples/chat` は `PUBLISH_TARGETS` に無く出荷面ではない【現物】が、⛔ **「出荷面でない」は「誰も使っていない」を意味しない。**
- **決定4 の警告行が `retrieval` の他の出力（JSON・基準値突き合わせ）に影響しないことは、読解で判断した**【推論・未検算】。stdout にしか足していない。
