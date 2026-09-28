# @mnemora/anthropic

`LLMProvider` の Anthropic 実装。zod スキーマを Anthropic のネイティブ構造化出力
（`output_config.format: json_schema`）へ翻訳する
（[docs/architecture.md](../../docs/architecture.md) §3.8）。

## ⚠ `EmbeddingProvider` は実装しない

**Anthropic は埋め込み API を提供していない**（公式には外部の埋め込みモデルの利用を案内している）。
そのため `@mnemora/anthropic` は `LLMProvider` のみを実装する
（[docs/architecture.md](../../docs/architecture.md) §4「オーナー案から変えた3点」）。

`@mnemora/core` の `createRuntime()` は `RuntimeDeps` として `llmProvider` と
`embeddingProvider` の**両方**を必須で要求する（`packages/core/src/runtime.ts`）。
⟹ **`@mnemora/anthropic` 単独では runtime を組めない。** 埋め込みが要る構成では、
`@mnemora/openai` 等の別 provider を embeddingProvider として併用すること。

```ts
import { createRuntime } from "@mnemora/core";
import { AnthropicLLMProvider } from "@mnemora/anthropic";
import { OpenAIEmbeddingProvider } from "@mnemora/openai";

// LLM は Anthropic、埋め込みは OpenAI ——LLMProvider と EmbeddingProvider は
// 独立した interface なので、provider を混在させて runtime を組める。
const runtime = createRuntime({
  // ...memoryStore / vectorStore / eventStore / outboxStore / tenantSettingsStore / hashContent は省略
  llmProvider: new AnthropicLLMProvider({ model: "claude-opus-5" }),
  embeddingProvider: new OpenAIEmbeddingProvider({
    model: "text-embedding-3-small",
    dimensions: 1536,
  }),
});
```

## インストール

```bash
pnpm add @mnemora/anthropic @mnemora/core
# または
npm i @mnemora/anthropic @mnemora/core
```

下の例をそのまま動かすなら、次も自分の依存として入れる（2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れて確かめた。README の install 行どおりに pnpm で入れると、最初の例は `Cannot find package '@mnemora/openai'` で止まった）:

- `@mnemora/openai`——最初の例は埋め込みに `OpenAIEmbeddingProvider` を使う（Anthropic は埋め込み API を持たない）。
- `zod`（`@mnemora/core` と同じメジャー、^4.5.4）——`completeStructured` に渡すスキーマを作る例で使う。

```bash
pnpm add @mnemora/openai zod
```

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `module`/`moduleResolution` を `nodenext` にし、TypeScript 5.8 以降を使うこと。
  5.7 以前の `nodenext` と、どの版の `node16` も `TS1479` になる。`node10` は TypeScript 5.x なら
  パッケージの入口の型を解決できるが、`exports` を読まないので `@mnemora/testkit/fixtures` のような
  subpath は解決できず、TypeScript 6 で非推奨・7 で廃止された。2026-09-27 に TypeScript 5.0〜7.0 で実測）
- **`ANTHROPIC_API_KEY` 環境変数**（または `apiKey` オプション）が要る。無いと Anthropic SDK の
  呼び出しが認証エラーになる（`new AnthropicLLMProvider(...)` は通り、`complete()` などを呼んだ時点で、SDK の素の `Error`
  `Could not resolve authentication method. ...` が伝わる。`AnthropicLLMProviderError` ではなく、`kind` も持たない）【実測 2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れ、ネットワークを切って走らせた】
- **`model` は必須。既定値を持たない**——どのモデルを使うかは常に呼び出し側が決める
  （`@mnemora/openai` の `OpenAILLMProvider` と同じ規律）

## 動く最小の例（型検査のみ確認・ANTHROPIC_API_KEY が無いため未実行）

```ts
import { AnthropicLLMProvider } from "@mnemora/anthropic";
import { z } from "zod";

// apiKey を省略すると ANTHROPIC_API_KEY 環境変数を読む。
// model は必須（既定値を持たない）。
const llmProvider = new AnthropicLLMProvider({ model: "claude-opus-5" });

const ctx = { tenantId: "tenant-1" };

const response = await llmProvider.complete(ctx, {
  messages: [{ role: "user", content: "こんにちは" }],
});
console.log(response.content);

// zod スキーマを渡すと、Anthropic のネイティブ構造化出力（output_config.format）経由で
// 検証済みの値が返る（core・呼び出し側に Anthropic SDK の型は一切出てこない）。
const schema = z.object({ summary: z.string() });
const structured = await llmProvider.completeStructured(ctx, {
  prompt: { messages: [{ role: "user", content: "要約して" }] },
  schema,
});
console.log(structured.summary);
```

## ⚠ 失敗は種類として返る（拒否を「空の成功」にしない）

**Anthropic の拒否は HTTP 200 で返る。**`stop_reason: "refusal"` が付いた成功応答であり、
SDK は例外を投げず、`content` にはテキストブロックが1つも無いことがある。
⟹ **このパッケージは `content` を読む前に `stop_reason` を見る。**

失敗は `AnthropicLLMProviderError` として投げられ、**`kind` で区別できる**:

| `kind` | 何が起きたか | 付いてくる情報 |
|---|---|---|
| `"refusal"` | 安全性の分類器が介入した | `refusalCategory`（`cyber` / `bio` / `frontier_llm` …。**開いた集合**） |
| `"truncated"` | 応答が途中で切れた | `stopReason`（`max_tokens` / `model_context_window_exceeded`）。**`maxTokens` を上げるか、プロンプトを短くする** |
| `"no_content"` | 上記のどれでもないのに、テキストブロックが無かった | — |

**⚠ 2026-09-26 追記（Issue #885）: `kind` が表すのはこの3種のどれかである。** HTTP 200 の
応答オブジェクトそのものの形が壊れている場合——トップレベルの `content` 欄がキーごと
丸ごと無い場合（`{}` が返る等）——は、`kind` の**外**にある生の例外（`TypeError` 等。
壊れた JSON の `SyntaxError`・スキーマ不適合の `ZodError` と同じ扱い）がそのまま伝播する。
`AnthropicLLMProviderError` にはならず、`instanceof` でも `kind` でも捕まえられない。
実 API がこの形を実際に返すかは確認していない（詳細は
[ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) の同日付追記）。

```ts
import { AnthropicLLMProviderError } from "@mnemora/anthropic";

try {
  await llmProvider.completeStructured(ctx, { prompt, schema });
} catch (error) {
  // ⚠ `instanceof` ではなく `kind` で分岐する
  //（bundler が同じクラスを二重に読み込むと `instanceof` は落ちる）。
  const kind = (error as AnthropicLLMProviderError).kind;
  if (kind === "refusal") {
    // 「モデルが答えなかった」ではなく「モデルが断った」。区別して扱えるようにしてある。
  }
}
```

**⚠ `complete()` は、拒否でも切り詰めでもない空応答に対しては、いまも空文字を返す。**
望ましい姿ではない——`@mnemora/openai` も同じ形であり、直すなら両方同時
（公開 API の破壊的変更）になるため、提起までにしてある
（[ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) の追記）。

## `@mnemora/openai` との違い

| 観点 | `@mnemora/openai` | `@mnemora/anthropic` |
|---|---|---|
| `EmbeddingProvider` | 実装する | **実装しない**（上記） |
| 構造化出力の形 | `response_format: json_schema`（`{ name, strict: true, schema }`） | `output_config.format: json_schema`（`{ type, schema }`。`name`/`strict` 無し） |
| optional フィールド | strict モードの制約で「全キー required + null 許容」に変換してから、null を省略へ戻す（`@mnemora/openai` の中の関数 `hardenForStrictMode` / `stripNulls`。どちらも export していない） | 変換不要——`.optional()` は optional のまま Anthropic 側の `required` に反映される |
| `system` | `role: "system"` のメッセージとして `messages` に積む | top-level `system` パラメータ（`prompt.system` と `role: "system"` のメッセージを連結する） |
| `max_tokens` | 省略可 | **必須**（`maxTokens` 省略時は `DEFAULT_MAX_TOKENS`） |
| `enum` / `min` / `max` | JSON Schema の制約としてそのまま送る | **制約としては送らない**——SDK の変換が `description` へ JSON 文字列として降格させる（[ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) 決定3b の実測） |

**⚠ 最後の行は「制約が緩い」という意味だが、`completeStructured` の戻り値は
両実装ともに `req.schema.parse` を通った検証済みの値である**——列挙から外れた値が
黙って通ることは無い（例外になる）。**止まる場所が違うだけである。**

`LLMProvider.complete` / `LLMProvider.completeStructured` の契約（core 側の interface）は
[`@mnemora/core`](../core/README.md) を参照。両実装が同じ契約に従うことは
`src/__tests__/provider-parity.test.ts` で検査している。

## 🔴 実 API には、適合テストを一度も当てていない

**採用する前に読むこと。**

**⚠ 2026-09-26 追記（`v1.0.1`、Issue #389 /
[ADR 0266](../../docs/decisions/0266-llm-provider-conformance.md)）**: この見出しは以前
「適合テスト（conformance suite）が、そもそも存在しない」だった。**それはもう成り立たない。**
`@mnemora/testkit` に `describeLLMProviderConformance` が新設され、このパッケージ
（`src/__tests__/llm-provider.conformance.test.ts`）と `@mnemora/openai` の両方に当てている
——**残る限界は下のとおりである。**

- **その適合テストは、注入した偽 client（固定応答）に当てているだけで、実 API には
  当てていない。**測っているのは「core の契約（ベンダー型を漏らさない・例外を同一性の
  まま伝播する・リトライを内蔵しない）を、`AnthropicLLMProvider` の変換ロジックが
  守っているか」であり、HTTP・認証・レート制限・実 API 自身の決定性ではない。
  **`src/__tests__/provider-parity.test.ts` は2実装を突き合わせる歯であって、
  契約そのものの歯ではない**（この区別は今も有効）。
- **実 API（Anthropic）にも、一度も当てていない。**`src/__tests__/live.anthropic.test.ts`
  の2本は `ANTHROPIC_API_KEY` と `MNEMORA_LIVE_ANTHROPIC` の二重 opt-in で、
  **CI にはどちらの環境変数も無い。**
- **⚠ これは「これから起きること」ではない。**`@mnemora/anthropic` は
  **`0.1.2` から `0.2.0` まで、既に npm へ公開されている**
  【実測 2026-09-17: `npm view @mnemora/anthropic versions` = 9版、`latest` = `0.2.0`】。
  ⟹ **いま入れている人が居るかもしれない、という前提で読むこと。**

**⛔ これは「動かない」という意味ではない。**このパッケージには固有の検査が在る
（`llm-provider.test.ts` / `llm-provider.conformance.test.ts` / `provider-parity.test.ts` /
`json-schema.test.ts` / `refusal.test.ts`）。**足りないのは、実 API そのものに当てた検査である。**

何が測られていて何が測られていないかの全体像は
**[docs/conformance.md](../../docs/conformance.md)** に在る。

## ⚠ 2026-09-26 追記（[Issue #884](https://github.com/takecchi/mnemora/issues/884)）: `client` を省略すると SDK 既定の再試行・timeout が効く

`client` を省略した `AnthropicLLMProvider` は `new Anthropic({ apiKey })` が作る SDK 既定の
クライアントを使う——**このクライアント自身が 429・5xx 等を内部で再試行する**
（実測: `@anthropic-ai/sdk@0.124.0` は既定 `maxRetries: 2`＝最大3回・`timeout: 600000`ms）。
`LLMProvider` の「自体はリトライを内蔵しない」は、mnemora の provider コードが再試行を
書いていない、という意味であり、SDK が裏で再試行しないという意味ではない。この数値は
SDK の既定値であり mnemora の契約ではないので、SDK の版が上がれば変わりうる。再試行の
回数・timeout を変えたい場合は、自分で作った `Anthropic` インスタンスを `client` に渡す:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLLMProvider } from "@mnemora/anthropic";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 60_000 });
const llmProvider = new AnthropicLLMProvider({ model: "claude-opus-5", client });
```

⚠ 2026-09-27 追記: この例は `@anthropic-ai/sdk` を自分の依存として入れないと動かない（pnpm では `Cannot find package '@anthropic-ai/sdk'`）。

🔴 **2026-09-29 訂正（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)、[ADR 0350](../../docs/decisions/0350-provider-client-type-decoupled-from-sdk-classes.md)）: 上の「同じ版を入れること」はもう要らない。** `client` の型は `Pick<Anthropic, "messages">`（`@anthropic-ai/sdk` パッケージのクラスをそのまま切り出した型）から、`@mnemora/anthropic` 自前の構造型 `AnthropicMessagesClient`（`@anthropic-ai/sdk` パッケージの型を一切参照しない）へ変わった。**`@anthropic-ai/sdk` を自分の依存として入れる版は、`@mnemora/anthropic` が固定している版（`0.124.0`）と揃える必要が無い**——最新を入れても、`Anthropic` インスタンスはそのまま `client` に渡せる。移行の詳細は [CHANGELOG.md](../../CHANGELOG.md) の `[1.1.0]` 節を見ること。

## ⚠ 2026-09-27 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)）: `completeStructured` に渡せる zod の形（今の振る舞い）

`AnthropicLLMProvider.completeStructured` は、送る前に SDK の `zodOutputFormat`（zod の `toJSONSchema` と SDK の
`transformJSONSchema`）でスキーマを翻訳する。翻訳できない形は、**送る前に**素の `Error` を投げ、`messages.create` は呼ばれない
（`AnthropicLLMProviderError` の `kind` には入らない）。

【コードとテストで確かめた。Anthropic の実 API には当てていない】（歯: `src/__tests__/structured-output-zod-shapes.test.ts`）

| zod の形 | 結果 |
| --- | --- |
| `z.tuple` | 送る前に `Error`「`JSON schema must have a type defined if anyOf/oneOf/allOf are not used`」 |
| `z.date` | 送る前に `Error`「`Date cannot be represented in JSON Schema`」 |
| `transform` | 送る前に `Error`「`Transforms cannot be represented in JSON Schema`」 |
| `z.record`・`z.lazy`（再帰）・`default`・根が union | 翻訳は通り、送る。**送った後に Anthropic が受けるかは確かめていない** |

⚠ 2026-09-28 追記: `z.record` は「通る」が、**送られる形は元のスキーマと意味が違う。**SDK の `transformJSONSchema` が
`additionalProperties: false` を強制し、record のキーと値の制約（`propertyNames` など）を `description` に JSON の文字列として
降格させるので、送る JSON Schema は `{ "type": "object", "properties": {}, "additionalProperties": false, "description": "{propertyNames: …}" }`
になる——**空の object しか許さない形**である（`z.record(z.string(), z.string())` を翻訳して確かめた。Anthropic の実 API には当てていない）。
⟹ Anthropic が制約どおりに出力すれば、record の欄はいつも `{}` で返る。歯は `src/__tests__/structured-output-zod-shapes.test.ts`。

文面は zod・SDK のもので、プロンプトの本文や API キーは含まない。`@mnemora/openai` は同じ形を送る前には落とさず、
送った後に OpenAI が 400 で拒む（あちらの README に実測）。2つの provider の振る舞いをそろえるかは決めていない（#1148）。

**core が渡す4つのスキーマは、送る前の変換を通る**【2026-09-27、偽の `client` で確かめた。**射程は送る前の変換まで**——
Anthropic の実 API が、送った JSON Schema を受けるかは確かめていない】（歯: `src/__tests__/core-schemas-send-shape.test.ts`）。

| スキーマ（使う口） | 送る JSON Schema の根 |
| --- | --- |
| `ExtractionResultSchema`（`observe`・`reextract`） | `type: "object"` |
| `ClaimKeyBatchResultSchema`（`observe` の `claimKey`） | `type: "object"` |
| `ConsolidationLLMResultSchema`（`consolidate`） | `type: "object"` |
| `ReflectionLLMResultSchema`（`reflect`） | `anyOf`（`type` なし。判別可能ユニオンの2つの枝が、どちらも `type: "object"`） |

runtime の5つの口（`observe`・`claimKey` 付きの `observe`・`reextract`・`reflect`・`consolidate`）は、どれも
`messages.create` まで届いて `output_config.format.schema` を送る。4つのどれにも、送る前に落ちる形（`z.tuple`・`z.date`・
`transform`）は含まれていない。

⚠ 送る形の中身で、次の2つは確かめたことの記録として書く（直していない）:

- `reflect` は、根が object でない JSON Schema をそのまま送る。`@mnemora/openai` は OpenAI が根に object を要求するので包んで
  送る（PR #1147）が、Anthropic 側は包んでいない。Anthropic がこの形を受けるかは確かめていない。
- 判別の値（`outcome` の `"reflected"`/`"nothing"`）と `z.enum` の値（抽出の `provenanceKind` など）は、`transformJSONSchema` が
  JSON Schema の制約としては残さず、`description` に JSON の文字列として埋め込む（`json-schema.ts` の冒頭のコメント）。
  返った JSON は `req.schema.parse` で検査するので、値が外れていれば `ZodError`（抽出なら全文フォールバック、
  `consolidate`/`reflect` なら `llm_failed`）になる。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §3.8・§4・§5.4 — `LLMProvider` の契約と provider 構成
- [ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) — このパッケージを足した判断と、
  採らなかった案・引き受けた負債・確かめていないこと
- リポジトリ: https://github.com/takecchi/mnemora
