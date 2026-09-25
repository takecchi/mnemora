# ADR 0304: `sanitizeCandidateSubjectId` は文字列 `"null"` を明示的な `null` として扱う（Issue #608 項目②(b) 追補、gpt-4o-mini 実測）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この ADR は、自動化された担い手（マネージャーから Issue #608 の実 API 検証・
> 修正を切り出された worker セッション、mgr-c9f55e15）が書いた。⛔ オーナー本人の
> 判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> `docs/north-star.md` の方向そのものを変える判断ではなく、[ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md)
> と [ADR 0287](./0287-extraction-subject-candidates-caller-supplied.md) が明示していた
> 「実 API で未検証」という負債を、実 API に当てて埋める技術的な追補である。

**⚠ 各主張の出所を分ける**（ADR 0271/0287 の体裁を踏む）:

- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【実測】** — 実際に `vitest`/`node` を走らせて確かめた。
- **【推論】** — 読解・設計判断から導いたが、実測ではない。
- **【受】** — マネージャーの委譲文で受け取った方針。この作業では再検討していない。

---

## 問い —— ADR 0271/0287 が残した「実 API 未検証」の負債を埋める

[ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md) は
「引き受けた負債」2で「OpenAI へ送る実際の JSON Schema が変わることを実 API で検算していない」
と、[ADR 0287](./0287-extraction-subject-candidates-caller-supplied.md) は「引き受けた負債」1で
「実際の LLM が候補一覧の中から正しく選ぶか・一覧に無ければ `null` を明示的に返すかは
測っていない」と、それぞれ明示していた。

**本 ADR に先立つ調査（コミットなし、マネージャーへ別途報告）で、`gpt-4o-mini` に実 API を
当てて次を確認した**（以下すべて【実測】、モデルは `gpt-4o-mini`——`examples/chat/src/providers.ts:123`
の `OPENAI_LLM_MODEL` と同じ repo 既定）:

1. `subjectId` を含む拡張スキーマ（`ExtractedMemoryCandidateSchema`、`packages/core/src/extraction.ts`）は
   `packages/openai/src/json-schema.ts` の `translateForOpenAIStructuredOutput` 経由で
   実 API に問題なく受理される（400 にならない）。
2. `subjectCandidates` を渡すと、`buildSubjectCandidateInstruction`
   （`extraction.ts`）が足す「一覧のどれにも当てはまらない場合、またはその記憶が
   主題を持たない場合は、その候補の `subjectId` に明示的に `null` を設定してください」
   という指示に対し、**`gpt-4o-mini` は JSON の `null` リテラルではなく、ダブルクォート
   付きの文字列 `"null"` を返した（累計 5/5 回）**。入力例:
   `{text:"明日台風来るらしいよ", speaker:"A", subjectId:"A", subjectCandidates:["A","B","movie-1"]}`
   → raw JSON: `{"...,"subjectId":"null",...}`（クォート付き）。
3. `subjectCandidates` を渡さない既存経路では、モデルは同じ状況で**本物の JSON `null`**
   を返した（2/2 回）。**この違いは `subjectCandidates` の有無で系統的に分かれた**——
   プロンプトが「null」という語を明示的に指示すると、モデルがそれを文字列として
   引用してしまう、という実測された事象である。
4. 修正前のコードでは、上記2の文字列 `"null"` は `sanitizeCandidateSubjectId`
   （`extraction.ts`）の「一覧内に含まれるか」検査に落ち、**一覧外の値として弾かれ
   （`rejected: true`）**、`undefined`（未指定）へ戻り、`buildNewMemoryFromCandidate`
   が observation の `subjectId`（上の例では `"A"`）へフォールバックしていた。
   ⟹ Issue #608 の例2（「明日台風が来る 主題＝なし」）を、`subjectCandidates` 付きの
   経路では**実 API 上ついに一度も達成できていなかった**。

**マネージャー判断【受】**: `sanitizeCandidateSubjectId`（または `sanitizeExtractionCandidates`）で、
候補一覧が渡されていて（非空）、LLM が返した `subjectId` が文字列 `"null"` で、かつ
`"null"` という文字列自体が候補一覧に含まれていないときは、明示的な `null`（主題なし）
として扱い、`rejected` にしない。候補一覧が無い経路・プロンプト文面・`packages/openai`
の provider（`stripNulls`）は1バイトも変えない。

---

## 決めたこと

### 1. `sanitizeCandidateSubjectId` に文字列 `"null"` の特例を1つ足す

`packages/core/src/extraction.ts` の `sanitizeCandidateSubjectId`:

```ts
if (allowedSubjectCandidates.includes(subjectId)) {
  return { subjectId, rejected: false };
}
if (subjectId === "null") {
  return { subjectId: null, rejected: false };
}
return { subjectId: undefined, rejected: true };
```

**判定の順序が本質**: 「一覧内に含まれるか」チェックが先に走るため、**もし呼び出し側が
候補一覧そのものに文字列 `"null"` を含めていたら**（実運用ではまず無いが、型としては
`z.string().min(1)` を満たす普通の文字列である）、その場合は通常どおり「一覧内の値」
として扱われ、この特例には落ちない。特例が拾うのは「一覧に `"null"` という候補が無く、
かつ LLM が `"null"` という文字列を返した」場合だけである。

### 2. `sanitizeExtractionCandidates` の分岐を「rejected の真偽」から「値が変わったか」へ変える

上の特例は `rejected: false` のまま `subjectId` を `"null"`（文字列）→ `null`（本物の
null）へ書き換える。**しかし `sanitizeExtractionCandidates`（同ファイル）の既存実装は
`if (!result.rejected) { return candidate; }` と、`rejected` が false なら**元の
`candidate` をそのまま返しており**、この書き換えが反映されずに文字列 `"null"` が
`ExtractedMemoryCandidate.subjectId` として素通りしてしまう**バグを産んだ（実装中に
テストで発見、下記「歯」参照）。

`sanitizeExtractionCandidates` を「`result.subjectId !== candidate.subjectId` なら
書き換えを反映する」形に直した——`rejected` は「`rejectedSubjectIds` に記録するか」
だけを決め、「`subjectId` を書き換えるか」は別の条件（値が実際に変わったか）で判定する。
この2つの問い（記録するか／書き換えるか）は ADR 0287 時点では常に一致していた
（弾いた場合だけ書き換えていた）ため1つの `if` で足りていたが、本 ADR の特例
（「書き換えるが弾かない」）でその一致が崩れ、分離が必要になった。

### 3. 候補一覧が無い経路・プロンプト文面・provider は1バイトも変えない

- `buildExtractionPrompt`・`EXTRACTION_PROMPT_SYSTEM_BASE`・`buildSubjectCandidateInstruction`
  はいずれも変更していない——カセットの照合鍵（ADR 0271 前提1・ADR 0287 決定3）は
  この PR で動かない。
- `packages/openai/src/llm-provider.ts` の `stripNulls` は変更していない
  （下の「引き受けた負債」1参照）。
- `sanitizeCandidateSubjectId` の他の分岐（`undefined`/`null`/一覧内/一覧外の非
  `"null"` 文字列）はすべて既存のまま——今回の特例は「一覧外の文字列が、かつ
  ちょうど `"null"` という綴りのとき」だけに絞ってある。

---

## 歯（赤→緑、【実測】）

`packages/core/src/__tests__/extraction.test.ts` に赤の状態で以下を足し、実装前に赤で
あることを確認した:

- `sanitizeCandidateSubjectId（Issue #608 項目②(b)）` 配下の
  `文字列 "null"（LLM が JSON null の代わりに返す既知の事象）` describe（4本）
  - 一覧に `"null"` という文字列自体が候補として含まれていなければ、明示的な null
    として扱う（**赤**: `{subjectId: undefined, rejected: true}` を得ていた）
  - 一覧に `"null"` という文字列自体が候補として含まれているなら、通常の一覧内の
    値として扱う（この規約が優先）（実装前から緑——既存の「一覧内はそのまま」分岐が
    先に真になるため、退行しないことを確認する回帰の歯）
  - 一覧が `undefined`／空配列なら、文字列 `"null"` もただの文字列として素通しする
    （実装前から緑、既存経路が変わらないことの回帰の歯）
- `extractCandidates × subjectCandidates（Issue #608 項目②(b)）` 配下:
  `LLM が文字列 "null" を返した場合（実 API の既知の事象）、一覧外でも弾かれず null
  （主題なし）になる`（**赤**: `result.candidates[0]?.subjectId` が `"null"`（文字列）
  のまま——`sanitizeCandidateSubjectId` を直しただけでは
  `sanitizeExtractionCandidates` 側の書き換え漏れで赤のままだった。これが決定2の
  バグを見つけた経緯）

**赤（実装前、逐語）**:

```
❯ src/__tests__/extraction.test.ts (53 tests | 2 failed) 40ms
  × sanitizeCandidateSubjectId（Issue #608 項目②(b)） > 文字列 "null"（... 一覧に "null" ... 含まれていなければ ...
    AssertionError: expected { rejected: true, subjectId: undefined } to deeply equal { subjectId: null, rejected: false }
  × extractCandidates × subjectCandidates（... LLM が文字列 "null" を返した場合 ...
    AssertionError: expected undefined to be null
```

**中間（`sanitizeCandidateSubjectId` だけ直した段階、逐語）**:

```
❯ extractCandidates × subjectCandidates（... LLM が文字列 "null" を返した場合 ...
  AssertionError: expected 'null' to be null
```

**緑（両方直した後）**: `pnpm --filter @mnemora/core exec vitest run src/__tests__/extraction.test.ts`
→ **53/53 成功**。`pnpm --filter @mnemora/core exec vitest run src/__tests__/runtime.test.ts -t "subjectCandidates"`
→ **10 passed | 80 skipped**（既存の `observe: subjectCandidates` 系回帰の歯がすべて緑のまま、
`rejectedSubjectIds` のキー有無・空配列規約・deferred との排他などが壊れていないことを確認）。
`pnpm --filter @mnemora/core run typecheck` も通過。**全テストは走らせていない**
（関係するファイルだけに絞った、マネージャーの指示どおり）。

---

## 実測: 修正後、実 API で台風ケースを再検証

`gpt-4o-mini`・`subjectCandidates: ["A","B","movie-1"]`・`observation.subjectId: "A"`・
入力 `"明日台風来るらしいよ"` で、修正後のコードを使い `runtime.observe()` を3回実行:

| 試行 | `ObserveResult.rejectedSubjectIds` | `Memory.subjectId` |
| --- | --- | --- |
| 1 | `[]` | `null` |
| 2 | `[]` | `null` |
| 3 | `[]` | `null` |

**3/3 回とも期待どおり**——observation の `"A"` に上書きされず、`rejectedSubjectIds` に
`"null"` が記録されることもなくなった。Issue #608 の例2（「明日台風が来る 主題＝なし」）が
`subjectCandidates` 経路で実 API 上初めて再現した。

**この検証を含む API 呼び出しは合計 5 回以内**（マネージャー指示の上限）——内訳:
修正後の台風ケース再実行 3 回のみ（先行調査の10回は本 ADR の対象外、別報告に記載済み）。
API キーの値は一切出力・保存していない。

---

## 引き受けた負債

1. **`packages/openai/src/llm-provider.ts` の `stripNulls` は直していない。** 本 ADR の
   調査（コミットなし）で、`stripNulls`（`llm-provider.ts:48`）が OpenAI から返った
   JSON を無条件に再帰的に `null → undefined（キー除去）` へ変換しており、
   `ExtractedMemoryCandidateSchema.subjectId` のように `null` 自体が意味を持つ
   フィールドと、`digest`/`tags` のように「optional だが nullable ではない」フィールドを
   区別していないことを確認済み。**実測**: `subjectCandidates` を渡さない既存経路で、
   モデルが本物の JSON `null` を返した場合（2/2 回）、`stripNulls` を素朴に「`subjectId`
   だけ null を通す」ように直すと、**existing 呼び出し（`subjectCandidates` を渡さない、
   observation 側に `subjectId` を持つ呼び出し）で、意図しない `null` 上書きが起きる**
   ことを、`stripNulls` を迂回する対照実装で実証済み（observation の `"A"` が `null` に
   上書きされた）。⟹ **この負債を今回は直さない理由**: (a) 直すと既存呼び出しへの
   回帰を招くため、`subjectCandidates` の有無で `stripNulls` の挙動を分岐させる設計が
   別途要る（`OpenAILLMProvider.completeStructured` は `subjectCandidates` を知らない
   ——`extraction.ts` 側の関心事であり、provider 層に候補一覧の有無を伝播させる経路が
   無い）。(b) 本 ADR が採った文字列 `"null"` の特例だけで、実測した限りでは
   `subjectCandidates` 経路の主要な失敗モード（Issue #608 の例2）は解消できており、
   `stripNulls` を触る動機が薄い。(c) `stripNulls` を直す設計は `packages/openai` の
   公開契約（`completeStructured` の意味論）に触れる変更であり、本 PR の切り出し範囲
   （`packages/core` の `sanitizeCandidateSubjectId` 1関数）を超える。**将来 `stripNulls`
   を直す場合は、この負債と上の実測（2/2 回で本物の null が既存経路で返る）を
   踏まえること。**
2. **「1発話→複数主題への分割」は観測記録に留める。** 調査中、Issue #608 の例1
   （Aの発話「この前映画観に行ってきたけど面白かったよ」から「Aは面白いと思った
   (主題=A)」と「映画をやっている(主題=movie)」の2件への分割を期待）を
   `subjectCandidates: ["A","B","movie-1"]` で試したところ、`gpt-4o-mini` は
   **1件だけ**の候補（`subjectId: "movie-1"`）を返し、Issue が期待する2分割は
   観測されなかった（単一トライアル）。これは抽出プロンプトの粒度・モデルの
   判断の問題であり、`subjectCandidates`/`sanitizeCandidateSubjectId` の検証ロジックの
   バグではない——プロンプトの文面（`EXTRACTION_PROMPT_SYSTEM_BASE`）は本 ADR も
   ADR 0287 も変えておらず、射程外として記録のみ残す。
3. **文字列 `"null"` の実測は `gpt-4o-mini` 限定であり、少ない試行回数（5回）に基づく。**
   他のモデル（`gpt-4o`、`gpt-4.1` 等）・他言語のプロンプトで同じ事象が起きるかは
   確認していない。将来別モデルで「文字列 `"null"` ではなく別の非標準表現（例:
   `"NULL"`、`"none"`）を返す」ことが分かったら、この特例は再検討が要る——
   個別の綴りを1つずつ追加するのではなく、`subjectId` の正規化をより一般的な形
   （例: 大文字小文字を無視した比較、既知の非標準表現のホワイトリスト）にすべきか
   判断すること。

## これが覆るとしたら

- **`stripNulls`（引き受けた負債1）を直す設計が固まったとき。** そのときは本 ADR の
  実測（既存経路で本物の `null` が返り、素朴な fix が回帰を生む）を踏まえること。
- **他のモデルで `"null"` 以外の非標準表現が実測されたとき**（引き受けた負債3）。
- **Issue #608 の例1（1発話→複数主題への分割）が別の Issue として切り出されたとき**
  （引き受けた負債2）——プロンプト側の変更が要り、カセット鍵への影響
  （Issue #370/#371）を踏まえた別の ADR になる。

## 参照

- [Issue #608](https://github.com/takecchi/mnemora/issues/608)
- [ADR 0271](./0271-extraction-candidate-subject-id-overrides-observation.md) — Issue #608 項目①。
  `null`/`undefined` の線引きを導入
- [ADR 0287](./0287-extraction-subject-candidates-caller-supplied.md) — Issue #608 項目②(b)。
  `subjectCandidates`・`sanitizeCandidateSubjectId`・`rejectedSubjectIds` を導入。
  「引き受けた負債」1（実 API 未検証）を本 ADR が引き取る
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
