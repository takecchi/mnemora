# ADR 0360: `completeStructured` は、送れない zod の形を送る前に `kind: "schema_unsupported"` で落とす

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`node` 等を走らせて確かめた。
- **【受】** — 委譲元（クローン miku）または過去の Issue コメントから受け取った前提。自分では再導出していない。

---

## 問い（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)）

利用者が `completeStructured` に自分の zod スキーマを渡せる（`LLMProvider` の公開の口）。
Issue #1148 のコメント（クローン miku の委譲先、2026-09-27）が【実測】したとおり、
`z.record`・`z.tuple`・`z.date`・`transform` の4形について、2つの provider の振る舞いが
食い違っていた:

| zod の形 | `@mnemora/openai`（当時） | `@mnemora/anthropic`（当時） |
| --- | --- | --- |
| `z.record` | 翻訳は通り、そのまま送る（実 API は 400 で拒む見込み。【実測】済み） | 翻訳が通り、送る |
| `z.tuple` | 翻訳は通り、そのまま送る（同上） | 送る前に素の `Error` |
| `z.date` | `unrepresentable: "any"` で型の無いスキーマとして通り、送る | 送る前に素の `Error` |
| `transform` | 同上 | 送る前に素の `Error` |

Issue が残した決めていないこと3点:

1. OpenAI で、SDK の strict 検査が落とす形を送る前に落とすか。
2. 送る前に落ちる失敗に `kind` を付けるか（今はどちらの provider も `kind` の外）。
3. `z.date`・`transform` のように、OpenAI 側で型の無いスキーマとして送られ、受けた後の
   `req.schema.parse` で初めて落ちる形をどう扱うか。

本 ADR はこの3点のうち1・2を決める（3は、この ADR の変更で「送る前に落ちる」側へ移るため、
そのままでは残らない——下の「決めたこと」参照）。

**この変更の方向はクローン miku が委譲先へ渡したものであり、オーナーの判断ではない。**
`OpenAILLMFailureKind`/`AnthropicLLMFailureKind` に値を1つ足す変更（`"schema_unsupported"`）は
公開の union を広げる変更だが、オーナーの回答（ask_human `d9364c91`。「公開の union 型に
値を足す変更は破壊的変更として数えない」、`docs/migration-v1.md`「数え方の規律への追記
（2026-09-28）」）により、破壊的変更としては数えない。

## 決めたこと

1. **`@mnemora/openai`: `structured-root.ts` の `toBaseJsonSchema` から `unrepresentable: "any"`
   を外す。** zod の既定（省略＝throw）に戻す。これにより `z.date()`・`.transform(...)` は、
   翻訳の時点（`z.toJSONSchema` の呼び出し自体）で `Error`（「Date cannot be represented in
   JSON Schema」「Transforms cannot be represented in JSON Schema」）を投げるようになる。
   core の4スキーマ（`ExtractionResultSchema`・`ClaimKeyBatchResultSchema`・
   `ConsolidationLLMResultSchema`・`ReflectionLLMResultSchema`）はこの既定でも投げないことを
   【実測】済み（`src/__tests__/core-schemas-send-shape.test.ts`）。

2. **`@mnemora/openai`: 送る直前に、実際に送る翻訳済みスキーマを、`openai` SDK 自身の strict
   検査 `toStrictJsonSchema`（`openai/lib/transform`）に通す。** 戻り値は使わない——検査だけが
   目的であり、**送るのは今までどおり mnemora 自身の翻訳結果**である（`toStrictJsonSchema` は
   内部で `structuredClone` するため、渡したスキーマ自体も変更しない）。この検査が
   `z.record`（`must set additionalProperties: false`）・`z.tuple`（`unsupported keyword
   prefixItems`）を捕まえる。

3. **自前の strict 検査は書かない。** 既存の `hardenForStrictMode`（`json-schema.ts`）はそのまま
   維持し、検査は SDK 自身の `toStrictJsonSchema` に委ねる——mnemora が「OpenAI の strict の
   仕様」を独自に再実装・再検証しない。

4. **1・2 のどちらで投げた例外も、`OpenAILLMProviderError`（`kind: "schema_unsupported"`）に
   包んで `chat.completions.create` を呼ぶ前に投げ直す。** 元の例外は `cause`
   （ES2022 の `Error.cause`。`super(message, { cause })` の形）にそのまま載せる。

5. **`@mnemora/anthropic`: `translateForAnthropicStructuredOutput`（SDK の `zodOutputFormat`）が
   投げる素の `Error` を、`AnthropicLLMProviderError`（`kind: "schema_unsupported"`）に包んで
   `messages.create` を呼ぶ前に投げ直す。** 元の例外は同じく `cause` に載せる。**`z.record` は
   対象外**——今までどおり翻訳が通り、送る（Anthropic 側では record は「空の object」に
   降格するだけで、翻訳自体は失敗しないため。ADR の対象は「翻訳・検査が例外を投げるもの」
   だけであり、record はそれに当たらない）。

6. **`OpenAILLMFailureKind`・`AnthropicLLMFailureKind` に同じ名前の値 `"schema_unsupported"` を
   足す。** 両 provider で同じ名前にすることで、呼び出し側が provider を差し替えても
   同じ `kind` で分岐できる（`docs/architecture.md` の「`LLMProvider` は差し替え可能でなければ
   ならない」という既存の決定に沿う）。

7. **包む範囲は、スキーマの翻訳と送る直前の検査で投げた例外だけに限る。** ネットワークの
   失敗・応答側の失敗（`JSON.parse` の `SyntaxError`、`req.schema.parse` の `ZodError`）は
   今までどおり素通しする——`kind` を持たない。拒否・切り詰め・空応答（`kind: "refusal"`・
   `"truncated"`・`"no_content"`）も今までどおりで変えない。

8. **`z.lazy`・`default`・Anthropic 側の `z.record`・根が union の包み（PR #1147）は、
   今までどおり通す。** この ADR はこれらの経路を変えない。

## なぜ `toStrictJsonSchema` を使うか（自前で書かない理由）

`openai` SDK は Structured Output の strict モードの制約（全 object に
`additionalProperties: false`・`properties` の全キーを `required` に含める・`prefixItems` 等の
未対応キーワードの拒否）を、`lib/transform.js` の `toStrictJsonSchema` として実装し公開している
（`package.json` の `exports` の `"./lib/*"` パターンで到達可能）。この制約は OpenAI 自身が
定めるものであり、mnemora が独自に再実装すると:

- SDK の版が上がって制約が変わったときに、mnemora 側の複製が追随しない可能性がある。
- 「SDK の検査」と「mnemora の検査」の2つの正本ができ、食い違ったときにどちらを信じるかが
  曖昧になる。

⟹ **SDK 自身の検査を、実際に送る値に対して呼ぶ**のが最も直接的で、複製を持たない形である。

## 検討した代替案

- **自前の strict 検査を書く**: 却下（上の「決めたこと」3・「なぜ `toStrictJsonSchema` を
  使うか」）。SDK の制約を再実装すると、SDK の版が上がったときに追随せず、2つの正本が
  食い違うリスクを負う。
- **`zodResponseFormat`（`openai/helpers/zod`）で検査する**: `openai` SDK が公開している、
  より上位のヘルパー。しかし `zodResponseFormat` は「zod スキーマから直接 JSON Schema を作って
  検査する」関数であり、**mnemora 自身の翻訳結果（`hardenForStrictMode`・`wrapRootSchema` を
  経た後の JSON Schema）を検査対象にできない**——SDK が内部で独自に `z.toJSONSchema` を
  呼び直すため、mnemora の翻訳と2重に翻訳することになり、「実際に送る値」を検査したことに
  ならない。`toStrictJsonSchema` は JSON Schema を直接受け取るため、mnemora の翻訳結果を
  そのまま渡せる——この差が採用の決め手だった。【実測】`/tmp/mgr-2a7c41e2-probe.mjs`
  （委譲元が用意した確認用スクリプト）で、`zodResponseFormat` は `z.record`・`z.tuple` に対し
  `toStrictJsonSchema` と同種の `Error` を投げることを確認したが、上記の理由で採らなかった。
- **SDK の出力（`zodResponseFormat`/`toStrictJsonSchema` の戻り値）をそのまま送る**: 却下。
  検査のためだけに SDK の変換を呼び、送るのは mnemora 自身の翻訳結果のまま、という非対称な
  設計にした理由は次の2点——(1) 送る形を変えると、core の4スキーマについて「送る JSON が
  1バイトも変わらない」という既存の契約（本 PR で実測——下記）が崩れる。(2) 記録済みカセット
  （`examples/chat/cassettes/`）の鍵はプロンプトのみから決まり JSON Schema を含まないため
  直接は影響しないが、送る形が変わると「記録した時点の応答」（カセットの `value`）が
  今の翻訳結果と整合しなくなるリスクがあり、変える理由がない。
- **Anthropic 側も `z.record` を `schema_unsupported` にする**: 却下。`z.record` は Anthropic 側
  では翻訳自体が失敗しない（空の object に降格するだけ）。本 ADR が対象にするのは「翻訳・
  検査が例外を投げるもの」であり、record はこの基準に当たらない。2つの provider の振る舞いを
  無理に完全一致させるより、「対象の基準」を一貫させることを優先した。

## 【実測】赤→緑

`/tmp/mgr-2a7c41e2-red`（`origin/main` = `ad643ce`）に、この ADR が定める振る舞いを検査する
新規テストファイルを2本置き、直していない実装に対して走らせた:

```
pnpm --filter @mnemora/openai exec vitest run src/__tests__/schema-unsupported-before-send.test.ts
# 4 failed（z.record・z.tuple・z.date・transform のすべてで、OpenAILLMProviderError を期待したが
# 別の例外（偽 client の Error／ベンダー拒否の代わり）を受け取った）

pnpm --filter @mnemora/anthropic exec vitest run src/__tests__/schema-unsupported-before-send.test.ts
# 3 failed（z.tuple・z.date・transform で、AnthropicLLMProviderError を期待したが素の Error を
# 受け取った）、1 passed（z.record は今までどおり通ることを確認する対照ケース）
```

実装（`structured-root.ts`・`errors.ts`・`llm-provider.ts`、両 package）を直した後、同じ内容を
`src/__tests__/structured-output-zod-shapes.test.ts`（既存ファイルを新しい振る舞いに書き換え）
に統合し、両 package で緑を確認した:

```
pnpm --filter @mnemora/openai exec vitest run     # 15 passed | 1 skipped（139 tests | 13 skipped）
pnpm --filter @mnemora/anthropic exec vitest run  # 12 passed | 1 skipped（114 tests | 2 skipped）
```

## 【実測】変異試験

`cp` で退避してから、送る直前の検査（`toStrictJsonSchema` の呼び出し）をコメントアウトすると:

```
pnpm --filter @mnemora/openai exec vitest run src/__tests__/structured-output-zod-shapes.test.ts
# 2 failed（z.record・z.tuple。zod 自身の既定 throw で捕まる z.date・transform は緑のまま）
```

`cp` で戻し、同じ it が緑に戻ることを確認した（`pnpm --filter @mnemora/openai exec vitest run` で
15 passed | 1 skipped）。

Anthropic 側は、`translateForAnthropicStructuredOutput` を包む `try/catch` を外すと:

```
pnpm --filter @mnemora/anthropic exec vitest run src/__tests__/structured-output-zod-shapes.test.ts
# 3 failed（z.tuple・z.date・transform。素の Error のまま AnthropicLLMProviderError に包まれない）
```

`cp` で戻し、緑（12 passed | 1 skipped）に戻ることを確認した。

## 【実測】送る JSON が変わらないこと（OpenAI、core の4スキーマ）

`translateForOpenAIStructuredOutput` の出力を、直す前（`/tmp/mgr-2a7c41e2-red`）と直した後
（このブランチ）でそれぞれビルドし、core の4スキーマについて `JSON.stringify` した結果を
比較した——4スキーマとも1バイトも変わらない（`same=true`、バイト数も一致）:

```
ExtractionResultSchema same=true bytes(before)=674 bytes(after)=674
ClaimKeyBatchResultSchema same=true bytes(before)=360 bytes(after)=360
ConsolidationLLMResultSchema same=true bytes(before)=300 bytes(after)=300
ReflectionLLMResultSchema same=true bytes(before)=591 bytes(after)=591
```

これは、`toBaseJsonSchema` から外した `unrepresentable: "any"` が、そもそも「表現できない
形（date・transform 等）」にだけ効くオプションであり、core の4スキーマはこの4形を使わない
ため（`unrepresentable` オプションの有無に関わらず同じ出力になる）。`toStrictJsonSchema` は
検査のためだけに呼び、戻り値を使わないため、送る値そのものには一切関与しない。

## 【実測】記録済みカセットの鍵は動かない

`packages/testkit/src/__fixtures__/cassette.ts` の `llmCassetteKey` は
`{ system, messages }` の JSON の SHA-256 であり、`schema` を含まない（設計上の理由は
同ファイルの doc コメント——「スキーマは『何を返してほしいか』であって『何を訊いたか』では
ない」）。本 PR はどの provider の `PromptSpec` の組み立ても変えておらず、プロンプトの文面は
一切変えていない。⟹ 鍵は動かない。

これを検査する既存の歯（`examples/chat/src/__tests__/cassette-coverage.test.ts`）を走らせ、
26 件すべて緑であることを確認した:

```
pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/cassette-coverage.test.ts
# 26 passed
```

`packages/testkit/src/__tests__/cassette.test.ts`・`cassette-recorder.test.ts`（カセットの形式・
鍵の導出自体を検査する歯）も24件すべて緑であることを確認した。

## 引き受けた負債

- **`openai/lib/transform` は `openai` パッケージの文書化された入口ではない。** `package.json`
  の `exports` には `"./lib/*"` として載っており（型定義 `.d.mts` も存在する）実際に import
  できるが、README・公式ドキュメントで案内される入口（`openai` の主要 export、
  `openai/helpers/zod` 等）ではない。SDK の版が上がったときに、この関数のシグネチャ・
  挙動・存在そのものが変わる／消えるリスクを、mnemora が引き受けている。
  **気づく経路**: `pnpm --filter @mnemora/openai run typecheck`（import が解決できなくなれば
  型検査が赤くなる）と、`structured-output-zod-shapes.test.ts`（挙動が変われば、record・
  tuple が `schema_unsupported` にならなくなり赤くなる）の両方が歯として機能する。
- **`toStrictJsonSchema` が拾わない、実 API だけが拒む形が他にあるかは検証していない。**
  今回の4形（record・tuple・date・transform）については SDK の検査と実 API の拒否が一致する
  ことを Issue #1148 のコメントが【実測】しているが、これは網羅的な調査ではない——
  「SDK の strict 検査を通ること」は「実 API が受けること」の十分条件ではない、という
  Issue #1148 自身の指摘（`z.date`・`transform` は当時 SDK の検査を通るのに実 API は拒んで
  いた）がそのまま残る形の負債である。今回の変更は、SDK の検査を送る前に必ず通すように
  しただけであり、「SDK の検査を通れば実 API も必ず受ける」という主張はしていない。
- **`z.record` の扱いが2つの provider で割れたままである。** OpenAI 側は `schema_unsupported`
  にするが、Anthropic 側は通す。呼び出し側が provider を差し替えるコードを書いていて、
  かつ `z.record` を使っていると、片方の provider でだけ例外になる。`docs/architecture.md`
  の「`LLMProvider` は差し替え可能でなければならない」という決定への部分的な違反だが、
  Anthropic 側の `z.record` は翻訳自体が失敗しないため、この ADR の対象基準
  （「翻訳・検査が例外を投げるもの」）には当たらないと判断した——完全な振る舞いの一致は
  この ADR のスコープ外とする。

## 確かめていないこと

- **実 API を一切叩いていない。** `toStrictJsonSchema` を通った後の JSON Schema を、実際に
  OpenAI が受けるかは、Issue #1148 のコメントの2026-09-27 の実測（当時のコードに対する実測）
  を引用するのみで、この PR 自身では再実測していない。
- **Anthropic の実 API が、`z.record`（空の object に降格した形）を受けるかは確認していない**
  ——Issue #1148・本 PR のどちらも、Anthropic 側は偽の client でしか検査していない。
- **`openai@7.23.0`（`devDependencies` の `openai-latest`）・`@anthropic-ai/sdk@0.129.0`
  （`anthropic-sdk-latest`）で、`toStrictJsonSchema`・`zodOutputFormat` が同じ形で例外を
  投げるかは検証していない。** 固定した版（`openai@7.10.0`・`@anthropic-ai/sdk@0.124.0`）
  でのみ確認した。
