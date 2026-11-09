# ADR 0701: `inferred` の provenance に、応答を実際に返したモデル `respondedModel` を残す——設定値の `model` とは分け、確かめられないときは書かない

- **状態**: 採用 (2026-11)
- **日付**: 2026-11-10

**これは担い手（Claude Code のセッション）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所は、対話セッションの利用者の依頼「v2.0.0 で入れたい: 記憶の信頼性・整合性の改善」の課題A（Provenance の記録精度）。Issue [#2108](https://github.com/takecchi/mnemora/issues/2108)。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判断。

**⚠ この ADR の番号は仮である。** マージの直前に `node scripts/adr-renumber.mjs` が確定する（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）。

## 文脈【現物】

- `InferredProvenance.model` に入るのは `RuntimeConfig.llmModelId`（省略時 `"unknown"`）だけだった。書く経路は抽出の `buildProvenance` の1本である（`extraction.ts`）。
- `LLMResponse` は `{ content }` しか持たず、`completeStructured` は値 `T` だけを返す。provider の応答が持つ `model`（OpenAI の `ChatCompletion.model`、Anthropic の `Message.model`）は、どこでも読まれていなかった。
- ⟹ 渡し忘れれば `"unknown"`、渡し間違えれば違う名前が、型の上では「推論したモデル名」と区別できない形で残っていた。利用者が provider を包んで別のモデルへ逃がしても（フォールバック）、`model` は設定値のままだった。

## 何を決めたか【判断】

1. **`InferredProvenance` に任意の欄 `respondedModel?: string` を足す。** 応答を実際に返したモデル名である。`model` の意味（設定したモデル名）は変えない。schema は `z.string().min(1).optional()`。
2. **確かめられないときは書かない。** 次の場合は、`respondedModel` をキーごと省く。
   - provider が下の任意の口を実装していない。
   - 応答がモデル名を持たない、または空文字である。
   - 全文フォールバック（LLM を通っていない `stated` の記憶）。

   **無いことは「確かめていない」を意味し、`model` と同じだったことを意味しない。**設定値・既定値・推測で埋めない。
3. **`LLMProvider` に任意のメソッド `completeStructuredWithMeta?` を足し、`LLMResponse` に任意の欄 `respondedModel?` を足す。** 戻り値は `StructuredResponse<T> = { value: T; respondedModel?: string }`。core は抽出で、このメソッドがあれば呼び、無ければ従来の `completeStructured` を呼ぶ（内部の `callStructuredWithMeta`。公開しない）。
4. **包む provider（フォールバック・切り替え）は、実際に応答した中の provider の値をそのまま返す**、と契約に書く（`StructuredResponse` の TSDoc）。
5. **`@mnemora/openai`・`@mnemora/anthropic` は、応答の `model` を返す。** `completeStructured` は `completeStructuredWithMeta` の `value` を返す形にし、送る要求は変えない。構造型の `client-types` の結果型には `model?: string | null` を任意で足し、構造型の互換を保つ。
6. **適合テストを足す・広げる。**
   - `describeLLMProviderConformance` の条項1を変えた。以前は「`complete` の戻り値のキーがちょうど `["content"]`」だった。いまは「`content` と `respondedModel`（任意）だけで、`respondedModel` があるなら空でない文字列」である。core の契約の欄を許すだけで、ベンダー固有の欄はこれまでどおり落とす。
   - `completeStructuredWithMeta` を実装した provider には、同じ形の歯を当てる。
   - `describeMemoryStoreConformance` と core の壊れた入力の表に、「inferred で `respondedModel` が空文字」を足した（両方に足す決まり）。
7. **DB マイグレーションは要らない。** `memories.provenance` は jsonb で、CHECK 制約は `kind` しか縛らない。

## 互換性

- **型の上では非破壊**である。足したのは任意の欄・任意のメソッドだけで、公開 API の snapshot の差分も追加だけだった。
- 適合テストは、条項1を広げた（赤くなる入力が減る）。新しい歯は、任意の口を実装した provider と、空文字の `respondedModel` を受け付ける store にだけ当たる。
- `provenance` を exhaustive に読む呼び出し側は、新しいキーが現れうることだけ確かめればよい。

## 採らなかった案

- **`completeStructured` の戻り値を `{ value, respondedModel? }` に変える**（v2.0.0 の破壊的変更）。既存の外部 provider がすべて壊れる。「既存インターフェースへの変更は必要最小限」に反する。
- **`model` の意味を「応答したモデル」に変える。** 既存の記憶の `model` は設定値なので、同じ欄で意味が混ざる。
- **応答が `model` を持たないとき、設定値で埋める。** 未確認の値を確定値として扱うことになる。
- **`LLMProvider` に `modelId` を足し、`llmModelId` の既定値にする。** 省略時に `"unknown"` だった出力が変わる。今回の要件の外なので見送った。

## 引き受けた負債

- **LLM が作ったのにモデルが残らない記憶がある。** consolidate・reflect の結果（`consolidated`・`reflected` の provenance には欄が無い）と、claim key の LLM 呼び出しがそうである。今回は `inferred` だけを扱った。
- **`examples/chat` の参照例は `llmModelId` を渡しておらず、`model` は `"unknown"` になる。**
- 実 API が返す `model` の実際の値は確かめていない（偽 client で測った）。

## 確かめたこと【実測】

- core: `provenance-responded-model.test.ts`（7件）。設定値と応答の値が分かれること、任意の口が無い・省略・空文字なら書かないこと、reextract でフォールバック先の値に替わること、全文フォールバックには書かないこと、schema が空文字を拒むこと。
- provider: `llm-provider-responded-model.test.ts`（OpenAI・Anthropic 各5件）。応答の `model` が届き、無い・空文字・null なら省くこと。
- Postgres: `provenance-responded-model.postgres.test.ts`（2件）。jsonb の往復で保たれ、省いた記憶ではキーが現れないこと。適合テストの空文字の歯（6件）も緑。
- 変異試験（`cp` で退避・復元）。
  - `buildProvenance` から欄を落とす変異で、core の2件が赤になった。
  - 空文字を通す変異で、core の1件が赤になった。
  - provider が設定値で埋める変異で、provider の3件が赤になった。
  - どれも、戻すと緑に戻った。

## これが覆るとしたら

- provider の応答が、実際のモデル名ではない値（別名など）を `model` に返すと分かったとき。そのときは、欄の名前と意味を見直す。
- LLM が作る他の provenance（`consolidated`・`reflected`）にもモデルを残す必要が出たとき。同じ形で広げる。
