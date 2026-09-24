# ADR 0287: 呼び出し側が subject 候補一覧を渡し、抽出器に選ばせる口を足す（Issue #608 項目②(b)）

- **状態**: 採用 (2026-09-24)
- **日付**: 2026-09-24

> **⚠ この ADR は、自動化された担い手（マネージャーのセッションからさらに切り出された
> worker セッション）が書いた。**投稿者名・コミット署名が `takecchi` になっていても、
> それはオーナー本人を意味しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR に書かれた設計判断は、マネージャーのセッションが Issue 本文・repo の規約を
> 読んで下したものであり、オーナー本人がこの文面を承認したものではない。**

**⚠ 各主張の出所を分ける**（ADR 0271/0286 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【実測】** — 実際に `vitest`/`tsc`/`node` を走らせて確かめた。
- **【推論】** — 読解・設計判断から導いたが、実測ではない。

断りの無い【現物】は `origin/main` = `a1e7d2c`（本作業の分岐点）の木で行った。

---

## 問い —— [Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目②(b)

Issue #608 は4項目を並べ、[ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md)
（PR #612）が項目①（抽出候補ごとに `subjectId` を持てるようにする）を、
[ADR 0286](./0286-recall-include-subjectless.md)（PR #679）が項目③(b)（`includeSubjectless`）を
それぞれ実装した。本 ADR は項目②の残り半分——本文が並べた2つの選択肢のうち (b) を実装する。

> **提案**: ①を前提に、次のどちらか（あるいは両方）。
>
> - (a) 抽出プロンプトとスキーマに「何についての記憶か」を出させる
> - (b) **呼び出し側が既存の subject 候補一覧を渡し、抽出器に選ばせる**
>
> ⚠ **表記ゆれを止めたいなら (b) が要ります。** (a) だけだと、同じ対象が
> `インターステラー` / `interstellar` / `Interstellar` に割れます。mnemora は subject の
> 台帳を持たない設計（`packages/core/src/ctx.ts:1-15` のコメント、`docs/architecture.md`
> §3.7）なので、**台帳は呼び出し側が持つ前提で構いません** —— **渡す口だけが欲しいです。**

**マネージャーが (b) を選び、この ADR に切り出した。** (a) は選択肢のまま残す（下の
「採らなかった案」参照。**「ついでに直す」をしない**——`docs/autonomy.md`）。

ADR 0271 は「引き受けた負債」1でこう申し送っていた:

> **②が入るまで、この区別（`null`＝主題なし、`undefined`＝未指定）は実地で踏まれない。**
> 現時点の抽出プロンプトは主題について何も言わないため、LLM が `subjectId: null` を
> 明示的に返すことはまず無い。②を実装する側は、この線引きをプロンプトの指示に
> 反映する必要がある。

**本 ADR はこの申し送りを引き取る**（下の「決めたこと」3節）。

---

## 決めたこと

### 1. 入力欄は `subjectCandidates?: string[]`。`ObserveUtteranceInput`/`ObserveEventInput`/
`ObserveDocumentInput` に**追加のみ**で足す

`packages/core/src/observation.ts` の3つの入力型と、対応する zod スキーマに
`subjectCandidates?: string[]`（zod: `z.array(z.string().min(1)).optional()`）を足した。
要素は `z.string().min(1)`——`subjectId`/`Memory.subjectId` 等、他の subject 系文字列欄と
同じ規約。`ObserveMemoryUsageInput`（抽出器を通らない）には足していない。

**出力スキーマ（`ExtractedMemoryCandidateSchema`）には触れていない**——`subjectId` は
① (ADR 0271) が足したものをそのまま使う。本 ADR が触れたのは「呼び出し側からの入力」と
「抽出プロンプトの文面」と「runtime の検証」の3箇所だけである。

### 2. 空配列は「渡していない」と同じに扱う

`subjectCandidates: []` は、`undefined`（省略）と完全に同じ扱いにした——プロンプトも
変えず（下記3）、runtime の検証も行わない（下記4）。

**却下した対案**: 「空配列を渡したら、LLM が返す `subjectId` を常に無効化する（＝一覧が
無いので何を返しても弾く）」——却下した。空の一覧は「候補が無い」という呼び出し側の
状態を表しているにすぎず、「候補ゼロの一覧でだけ絞る」という極端な挙動に自然につながる
理由が無い。**検証しようが無いものは検証しない**、という一貫した規約にした
（`sanitizeCandidateSubjectId`（`packages/core/src/extraction.ts`）が
`allowedSubjectCandidates === undefined || allowedSubjectCandidates.length === 0` を
1つの分岐にまとめているのはこの規約の実装）。
`packages/core/src/__tests__/observation.test.ts`「空配列を受け付ける」と
`extraction.test.ts`「一覧が空配列なら、『渡していない』と同じで素通しする」で固定した。

### 3. プロンプト: 候補一覧が渡されたときだけ、system 文面に候補一覧と null の指示を足す。
渡されなければ1バイトも変えない

`buildExtractionPrompt`（`extraction.ts`）の既存の system 文字列を
`EXTRACTION_PROMPT_SYSTEM_BASE` という定数に切り出し、**この定数の文字列は本 ADR の前後で
1バイトも変えていない。** `subjectCandidates` が渡され（かつ空でなけ）れば、
`buildSubjectCandidateInstruction` が組み立てる次の文を末尾に足す:

```
この観測には主題（subjectId）の候補一覧が渡されています: <一覧をカンマ区切りで列挙>。
各記憶候補の subjectId には、この一覧の中から最も当てはまるものを1つだけ設定してください。
一覧のどれにも当てはまらない場合、またはその記憶が主題を持たない場合は、
その候補の subjectId に明示的に null を設定してください（省略しないでください）。
```

**候補一覧の列挙**（表記ゆれを止める、Issue 本文の目的）と**`null` の明示を求める指示**
（ADR 0271「引き受けた負債」1 の申し送り）を、1つの指示にまとめている。

**【実測】カセットの鍵（`llmCassetteKey` 相当）が動かないことを、鍵の計算そのもので確かめた**
——`packages/core` は `testkit` に devDependency を持てない（`dependency-boundary.test.ts`
が「dependencies のキーは `['zod']` のみ」と機械的に検査しており、`testkit` は `core` に
依存する側なので devDependency にすると循環になる）ため、`extraction.test.ts` に
`llmCassetteKey`（`packages/testkit/src/__fixtures__/cassette.ts`）と同じ正規化・ハッシュ
手順を `node:crypto` だけでローカル再実装し（`llmCassetteKeyLocal`）、
`subjectCandidates` を渡さない `buildExtractionPrompt(observation)` の鍵が
`7f158f7ed09fdfd049d8b833e53e8a2c8d550edf8c621bb20d5b99039c1e02f6` に固定されることを
歯にした（「subjectCandidates 省略時の鍵（llmCassetteKey 相当）は固定値のまま動かない」）。
渡した場合は鍵が変わることも別の歯で固定した（「渡すと、鍵は渡さない場合と異なる」）。

⟹ **Issue #370/#371（抽出プロンプトを変えるとカセットの鍵が全件変わる）は、この変更では
起きない**——`examples/chat` の既存の録音済みシナリオは1つも `subjectCandidates` を渡して
いない（本 ADR はその配線を追加していない、下の「確かめていないこと」4参照）ため、
既存カセットの照合鍵は1つも動かない。

### 4. runtime の検証: 一覧に無い `subjectId` は弾いて未指定へ戻す。`null` は一覧に無くても常に有効

`sanitizeCandidateSubjectId(subjectId, allowedSubjectCandidates)`（`extraction.ts`、
純関数）が判定する:

- `subjectId` が `undefined`（省略）または `null`（明示的な「主題なし」）なら、一覧の
  有無に関わらず常に有効。**`null` は「一覧のどれか」ではなく「主題を持たない」という
  別の値**であり、一覧に含まれている必要が無い——これは Issue 本文の例
  「Aさん『明日台風来るらしいよ』→ 明日台風が来る 主題 = なし」を、候補一覧に
  `null` という文字列を混ぜずに表現するための決定である。
- 一覧が渡されていて（空でなく）、`subjectId` が一覧に**無い**非 null 文字列なら、弾いて
  `undefined`（未指定）へ戻す——① (ADR 0271) の「省略」経路と同じ着地点で、
  `buildNewMemoryFromCandidate` が `observation.subjectId` へフォールバックする。

`extractCandidates`（`extraction.ts`）は LLM の応答（`result.memories`）を
`sanitizeExtractionCandidates` でこの関数に通してから返す。`reextract` はこの引数を
渡さないため（下記6）、`allowedSubjectCandidates === undefined` の分岐に落ちて常に素通し
——**① だけの既存呼び出し・`reextract` は、この PR で1バイトも挙動が変わらない。**

### 5. 「黙って戻さない」: 弾いた値を `ExtractCandidatesResult.rejectedSubjectIds` →
`ObserveResult.rejectedSubjectIds`（**新設・任意欄**）に残す

`ExtractCandidatesResult`（`extraction.ts`）に `rejectedSubjectIds?: string[]` を足した。
`extractCandidates` の2つの経路（成功・全文フォールバック）が両方とも必ず値を埋めるため
実際には常に配列だが、**型としては optional にした**——[ADR 0178](./0178-public-api-surface-gate.md)
が「新しい任意プロパティの追加」だけを semver 的に安全と定めているため、既存の型に
**必須**プロパティを足すと、この型を自前で実装している外部コード（`extractCandidates` を
模す独自のテストダブル等）がコンパイルできなくなる可能性がある。ADR 0271 が
`ExtractedMemoryCandidateSchema.subjectId` を同じ理由で optional にしたのと同じ判断。

`ObserveResult`（`runtime.ts`）にも同様に `rejectedSubjectIds?: string[]` を足した——
`observationId`/`memoryIds`/`extraction`/`extractionFailure` という既存の4欄は1つも
変えていない。**この欄が置かれる規約**:

- `subjectCandidates` を渡さなかった（省略・空配列）呼び出しでは、この欄は**無い**
  （`undefined`、キー自体が結果オブジェクトに現れない）——「候補一覧を渡していないので
  判定していない」ことと「渡したが0件だった」ことを、キーの有無で区別する。
- 渡した場合は常に配列（弾いた候補が無ければ `[]`）。

**なぜここに置いたか**: `ObserveResult` は `observe()` 呼び出し1回の結末を運ぶ、既存の
「置き場」である。新しい DB 列・新しい `memory_events.kind`・outbox のペイロード形の変更を
一切要求せずに、呼び出し側が「今回、一覧外として弾かれた値があったか」を知れる。
`memory_events`（`appendCreatedEvent`）の `meta` へ足す案も検討したが、「弾かれた」という
情報は Memory 単位ではなく `observe()` 呼び出し単位（同じ `subjectCandidates` を全候補が
共有する）の情報であり、`ObserveResult` の方が素直に対応する。⚠ **`memory_events` へは
足していない**——下の「確かめていないこと」5参照。

### 6. `extract: 'deferred'` と `subjectCandidates` は同時に渡せない。検証の段で明示的に例外にする

`runtime.observe`（`runtime.ts`）は、`ObserveInputSchema.parse` の直後・`Observation` を
1件も書き込む前に、`extractMode === 'deferred' && subjectCandidates` が非空なら
`SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX`（`observation.ts` にエクスポート、
`LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`（`recall.ts`）と同じ「エラー接頭辞を定数として
公開し、呼び出し側が文字列を検査できるようにする」規約）を先頭に付けた `Error` を投げる。

**理由**: `subjectCandidates` はどこにも永続化されない（下記7）。deferred 抽出は
`outbox` 経由で `Observation` を経由してから後で `processExtractJob` が処理するため、
実行時にはこの一覧を**構造的に見られない**。「渡されたのに黙って落とす」と、呼び出し側は
候補一覧が効いたと思い込む。⟹ 起きたことを呼び出し側から隠すことになるので、黙って落とさずに
例外にする。空配列は決めたこと2により「渡していない」と同じなので、
`extract: 'deferred'` と空配列の組み合わせはエラーにならない
（`runtime.test.ts`「extract: 'deferred' と空配列の subjectCandidates は、エラーに
ならない」で固定した）。

### 7. `subjectCandidates` は `Observation` にも DB にも持たせない。`reextract` はこの欄を使わない

`extractObservationPayload`（`runtime.ts`）は種類ごとに固定欄だけをペイロードへ書き出して
おり（`utterance` → `{ text, speaker }`、`event` → `{ name, data }`、`document` →
`{ title, content }`）、`subjectCandidates` はそこに無い。`Observation` 型・
`ObservationSchema`・`observations` テーブルのいずれにも触れていない——**新しい DB 列も
マイグレーションも無い。**

`reextract`（`runtime.ts`）は `MemoryStore.getObservation` で**DB から読み直した**
`Observation` しか持たないため、元の `ObserveXxxInput.subjectCandidates` はとうに
失われている。`runExtraction`/`extractCandidates` の `subjectCandidates` 引数は
`handleExtractableObservation` の sync 経路からだけ渡り、`reextract` はこの引数を渡さない
——**保存していないから使わない**のであって、対応していないからではない。

**【実測】** `runtime.test.ts`「reextract は候補一覧を使わない（保存されていないため）」で、
`observe()` 時点なら一覧外として弾かれていたはずの `subjectId`（`"user:ghost"`、
`subjectCandidates: ["user:a"]` に含まれない）が、同じ `observationId` に対する
`reextract()`（別の LLM 応答を返すよう差し替えた runtime）ではそのまま通ることを確認した。

---

## 採らなかった案

| 案 | 却下の理由 |
| --- | --- |
| **(2) `observations` に列を足して候補を保存する案**（[#280](https://github.com/takecchi/mnemora/issues/280) の migration 0014 と同じ形） | `Observation`/`ObservationSchema`/`observations` テーブルへの変更を要求し、マイグレーションが要る。これはスキーマに触れる判断であり、クローンが本 PR に置いた制約（adapter の interface にもスキーマにも触れない。スキーマはオーナーの領分とする）に反する。**この案を選ぶなら、observe した時点の候補一覧が `reextract` でも使える**という利点はあるが、その利点のためにマイグレーションを要求するコストは、本 Issue の依頼（「渡す口だけが欲しい」）に対して過大である |
| **(3) outbox のジョブの payload に載せる案** | `extract` ジョブの payload（`{ observationId }`）に `subjectCandidates` を足す案。`MemoryStore.createObservationWithOutbox` の interface（`jobKinds` に対応する payload の形）に波及し、`packages/postgres` の実装にも触れることになる——本タスクの制約「⛔ 変更が要ると分かったら、止めて報告すること」に該当しうる変更。かつ `reextract` は `extract` ジョブを経由しない独立した呼び出しであり、このジョブの payload に載せても `reextract` 側では依然として使えない——**②が達成したい「候補一覧を効かせる」という目的を、deferred 経路でも reextract 経路でも同時に満たすことができない中途半端な案になる** |
| **(a) 抽出器に自由に主題を出させる案**（プロンプトが「何についての記憶か」を自由記述で出させ、候補一覧を要求しない） | Issue 本文自身が「表記ゆれを止めたいなら (b) が要ります」と明記している——(a) だけでは同じ対象が `インターステラー`/`interstellar`/`Interstellar` に割れる。加えて、(a) は**既存の呼び出し（候補一覧を渡さない・渡す前提が無い）でもプロンプトの既定文面を変える**——本 ADR が決めたこと3で固定した「候補一覧が無ければ1バイトも変えない」という制約と両立しない。既定文面を変えると、Issue #370/#371（抽出プロンプトを変えるとカセットの鍵が全件変わる）がそのまま起き、実 API の鍵待ち（ADR 0271「⛔ 確かめていないこと」）と衝突する。⚠ **Issue 本文の表記**: 本文は②を「(a) または (b)（あるいは両方）」と両立可能なものとして提示しているが、(a) を「常に」プロンプトへ折り込む形で読むと本 ADR の非破壊制約と衝突する——**将来 (a) を足すなら、(a) 自体も opt-in（例: 別の任意フラグ）にする必要がある**、という指摘を残す |
| **deferred を黙って無視する案**（`subjectCandidates` を渡されても deferred なら黙って捨てて処理を続ける） | 呼び出し側が「候補一覧が効いた」と思い込んだまま、実際には一覧無しの抽出が実行される——起きたことを呼び出し側から隠すことになる。本 ADR は決めたこと6のとおり、検証の段で明示的に例外にする |
| **一覧に無い値をそのまま採る案**（LLM が返した `subjectId` を検証せず、一覧外でも候補の値として使う） | 表記ゆれを止めるという (b) の目的そのものが破れる——LLM が一覧に無い表記（例: 一覧が `["interstellar"]` なのに `"Interstellar"` と返す）をそのまま通すと、②が解決しようとした問題を素通りさせることになる。本 ADR は「一覧内」「`null`」以外を弾き、①の「省略」経路（observation の値へフォールバック）へ戻すことで、**呼び出し側が知らない値が Memory に紛れ込まない**ことを保証する |

---

## 引き受けた負債

1. **実際の LLM（OpenAI/Anthropic）が、候補一覧の中から正しく選ぶか・一覧に無ければ `null` を
   明示的に返すかは測っていない。** 本 ADR の歯はすべて決定的なスタブ `LLMProvider`
   （`llmProviderReturning`/`llmReturning`）を使っており、実 API に一度も当てていない
   ——ADR 0271「⛔ 確かめていないこと」と同じ制約（鍵はオーナーの回答待ち、
   [#142](https://github.com/takecchi/mnemora/issues/142) 項目1）。プロンプトの指示文言
   （決めたこと3）が実際に有効かどうかは、鍵が来て実 API に当ててから分かる。
2. **OpenAI の structured output（strict モード）への影響は、ADR 0271「引き受けた負債」2と
   同じ形で残っている。** 本 ADR は `ExtractedMemoryCandidateSchema`（出力スキーマ）には
   触れていないため、`translateForOpenAIStructuredOutput` が生成する JSON Schema 自体は
   ①の時点から変わらない——**この点は ADR 0271 の負債であって、本 ADR が新しく作った
   ものではない。** ただし本 ADR が足すプロンプト文言（system メッセージへの候補一覧・
   null の指示の追加）が、OpenAI 側のトークン数・応答の安定性に与える影響は測っていない。
3. **候補一覧の要素数に上限を設けていない。** 呼び出し側が数百件の subject 候補を渡すと、
   `buildSubjectCandidateInstruction` がそのまま system メッセージに列挙し、プロンプトの
   トークン数が線形に伸びる。北極星の物差し（毎回渡す量を減らす方向に働くか）に照らすと
   気になる点だが、Issue 本文は「渡す口だけが欲しい」としか要求しておらず、上限の値
   （何件で切るか）を決める根拠が無い——**この PR では上限を設けず、呼び出し側の裁量に
   委ねる**。将来、実運用で極端に長い一覧が渡される実例が見つかったら再検討する。
4. **`memory_events` には「弾いた」情報を残していない。** 決めたこと5のとおり
   `ObserveResult.rejectedSubjectIds` にだけ残した——`appendCreatedEvent` の
   `meta`（jsonb 列への追加キー、マイグレーション不要）に載せる案も検討したが、
   「どの候補が」ではなく「呼び出し全体でどの値が弾かれたか」という単位の情報であり、
   個々の `created` イベントに紐付けると「同じ値が複数の Memory の meta に重複して残る」
   （1回の `observe()` から複数候補が抽出されると、全候補が同じ `subjectCandidates` を
   共有するため）——`ObserveResult` という「呼び出し単位」の置き場の方が対応が良いと
   判断した。
5. **`examples/chat` はこの欄を配線していない。** `mnemora-path.ts` 等が
   `subjectCandidates` を渡す経路は無く、この PR の範囲にも含めていない——virchamate 側
   （Issue #608 の依頼元）が持つ subject 台帳を、この repo の中で模す実装は無いため。

## これが覆るとしたら

- **実 API で、プロンプトの指示文言（決めたこと3）が LLM に無視される・誤読されると
  分かったとき。** 文言を調整するか、(a) との併用（自由記述 + 一覧検証の二段構え）を
  再検討する。
- **候補一覧の要素数が実運用で問題になる長さになったとき**（引き受けた負債3）——
  上限、または呼び出し側にトリミングを促す警告を追加する。
- **`memory_events` 側に「弾いた」情報を残す必要が具体的に生じたとき**（引き受けた
  負債4）——`meta` へ足すか、`ObserveResult` だけで十分と判断された経緯自体を見直す。

## 参照

- [Issue #608](https://github.com/takecchi/mnemora/issues/608) — 本 ADR が実装する項目②(b)
- [ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md) — 同じ Issue の
  項目①。本 ADR が前提にする「候補ごとの `subjectId`」と「`null`/`undefined` の線引き」を
  足した先行 PR。「引き受けた負債」1（②を実装する側への申し送り）を本 ADR が引き取った
- [ADR 0286](./0286-recall-include-subjectless.md) — 同じ Issue の項目③(b)。体裁の見本、
  および ADR 0178 に基づく「追加のみ」の判断の直近の先例
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」が semver
  的に安全という基準。本 ADR の非破壊性の根拠
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) — 本 ADR の
  決定が自動化された担い手のものであることの根拠
- [Issue #370](https://github.com/takecchi/mnemora/issues/370) /
  [Issue #371](https://github.com/takecchi/mnemora/issues/371) — 抽出プロンプトを変えると
  カセットの鍵が全件変わる件。本 ADR が「候補一覧が無ければプロンプトを1バイトも
  変えない」ことに固執した理由
