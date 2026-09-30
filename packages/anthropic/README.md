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
| `"truncated"` | 応答が途中で切れた | `stopReason`（`max_tokens` / `model_context_window_exceeded`）。**`maxTokens` を上げるか、プロンプトを短くする**（⚠ 上げすぎると別の失敗になる。下の注） |
| `"no_content"` | 上記のどれでもないのに、テキストブロックが無かった | — |

⚠ **2026-10-01 追記（ADR 0445）: `maxTokens` を約 21,333 より大きくすると、SDK が「streaming が要る」と言って、リクエストを1本も送らずに素の例外（`AnthropicError: Streaming is required for operations that may take longer than 10 minutes…`。`kind` は付かない）で落ちる。** 実測（`@anthropic-ai/sdk@0.124.0`、`client` を省略）: 21000 は通り、22000・32000・64000 は落ちた。SDK が非ストリーミングの予想所要時間（`max_tokens` に比例）を 10 分と比べて拒むためである。**`client` に `timeout` を明示すれば通る**（`new Anthropic({ apiKey, timeout: 20 * 60_000 })` で 22000・32000・64000 とも送信された）。この境目は SDK の仕様であり mnemora の契約ではない。provider 側での検査や `kind` は足していない。

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

⚠ **2026-10-01 追記（ADR 0445）: `timeout` は試行ごとに効く。** 応答しないサーバーへ `timeout: 300, maxRetries: 2` で当てると、合計で約2.2秒かかった（3回試行・間の待ちを含む。擬似サーバーと実物の SDK、`@anthropic-ai/sdk@0.124.0`）。⟹ **最悪の合計時間は `timeout × (maxRetries + 1)` に、再送の待ち（指数バックオフ・`retry-after`）を足したもの**であり、既定（`timeout: 600000`・`maxRetries: 2`）なら 30 分を超えうる。`timeout: 60_000` だけを設定して `maxRetries` を既定のままにすると、最悪で約3分待つ。呼び出し全体の上限が欲しいなら、`signal`（`AbortSignal.timeout(ms)`）を `opts` に渡す（下の「`signal`（abort）を直に渡したときの振る舞い」）。

⚠ **同じく 2026-10-01 追記（ADR 0445）: 再送で治る失敗と治らない失敗がある。** SDK が再送するのは 429・5xx と、応答を受け取る前の接続の失敗である。**200 のヘッダを受け取った後に本文が途中で切れた場合は再送されず**、素の `TypeError`（`terminated`）になる——`embed` のジョブなら `failed` で終わり、`reembed` で回復する。mnemora の provider の側で再送する形にはしていない（Phase 1 に自動リトライは無い。ADR 0032・ADR 0157）。また **SDK の再送には冪等キーが付かない**（`x-stainless-retry-count` だけ）ので、プロバイダ側では呼び出しが2回に数えられうる（mnemora が書くのは1回だけ）。

⚠ 2026-09-27 追記: この例は `@anthropic-ai/sdk` を自分の依存として入れないと動かない（pnpm では `Cannot find package '@anthropic-ai/sdk'`）。

🔴 **2026-09-29 訂正（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)、[ADR 0350](../../docs/decisions/0350-provider-client-type-decoupled-from-sdk-classes.md)）: 上の「同じ版を入れること」はもう要らない。** `client` の型は `Pick<Anthropic, "messages">`（`@anthropic-ai/sdk` パッケージのクラスをそのまま切り出した型）から、`@mnemora/anthropic` 自前の構造型 `AnthropicMessagesClient`（`@anthropic-ai/sdk` パッケージの型を一切参照しない）へ変わった。**`@anthropic-ai/sdk` を自分の依存として入れる版は、`@mnemora/anthropic` が固定している版（`0.124.0`）と揃える必要が無い**——最新を入れても、`Anthropic` インスタンスはそのまま `client` に渡せる。移行の詳細は [CHANGELOG.md](../../CHANGELOG.md) の `[1.1.0]` 節を見ること。

## ⚠ 2026-09-27 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)）: `completeStructured` に渡せる zod の形（2026-09-29 に `kind` を足した——下の訂正を見ること）

`AnthropicLLMProvider.completeStructured` は、送る前に SDK の `zodOutputFormat`（zod の `toJSONSchema` と SDK の
`transformJSONSchema`）でスキーマを翻訳する。翻訳できない形は、**送る前に**落ち、`messages.create` は呼ばれない。

【コードとテストで確かめた。Anthropic の実 API には当てていない】（歯: `src/__tests__/structured-output-zod-shapes.test.ts`）

| zod の形 | 結果（当時＝2026-09-27。素の `Error` で、`kind` を持たなかった） |
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

文面は zod・SDK のもので、プロンプトの本文や API キーは含まない。

### 🔴 2026-09-29 訂正（[ADR 0360](../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）: `kind: "schema_unsupported"` を足した

**上の「素の `Error`」「`kind` を持たない」はもう成り立たない。**`z.tuple`・`z.date`・`transform` が送る前の翻訳で投げた例外は、
いまは `AnthropicLLMProviderError`（`kind: "schema_unsupported"`）に包んで投げ直す。**元の例外（上の表の文面）は
`cause`（ES2022 の `Error.cause`）にそのまま載る**——文面そのものは変えていない。`messages.create` が呼ばれないことも変えていない。
**（⚠ 2026-09-30 に、この段落の `z.record` の扱いを変えた——下の「2026-09-30 訂正」。以前ここには「`z.record` は今までどおり、`schema_unsupported` にはせず翻訳が通って送る。`@mnemora/openai` と、この点だけ振る舞いが割れる」と書いてあった。）**

### 🔴 2026-09-30 訂正（[ADR 0360](../../docs/decisions/0360-schema-unsupported-thrown-before-send.md) の同日の追記、負債3の解消）: `z.record` も送る前に `schema_unsupported` で落ちる

**上の表の `z.record` の行（翻訳は通り、送る）と、2026-09-28 追記の「空の object の形で送る」は、もう成り立たない。**
`z.record` を**含む**スキーマ（object の欄・配列の要素・`optional`/`nullable`/`default` の内側・union や intersection の枝・
`z.lazy` の先。深さを問わない）は、`AnthropicLLMProviderError`（`kind: "schema_unsupported"`）を投げ、`messages.create` は
呼ばれない。`cause` の `Error` に「`z.record` は送れない」旨が載る。理由は、翻訳が失敗しない代わりに、record の欄が例外無しで
**黙って空になる**こと。`@mnemora/openai` と同じ4形（`z.record`・`z.tuple`・`z.date`・`transform`）が、2つの provider で揃った。

- **代わりに**: record を `z.array(z.object({ key: z.string(), value: … }))` に置き換える（`docs/migration-v1.md` の未リリース節）。
- **今までどおり送る**: `z.lazy`（再帰そのもの）・`default`・根が union。`z.record` を含まなければ落ちない。
  送った後に Anthropic が受けるかは確かめていない。
- 検出は zod v4 の内部表現（`_zod.def.type === "record"`、`zod ^4.5.4`）に依存する。歯は
  `src/__tests__/structured-output-zod-shapes.test.ts`・`provider-parity.test.ts`。

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
`transform`・`z.record`）は含まれていない。

⚠ 送る形の中身で、次の2つは確かめたことの記録として書く（直していない）:

- `reflect` は、根が object でない JSON Schema をそのまま送る。`@mnemora/openai` は OpenAI が根に object を要求するので包んで
  送る（PR #1147）が、Anthropic 側は包んでいない。Anthropic がこの形を受けるかは確かめていない。
- 判別の値（`outcome` の `"reflected"`/`"nothing"`）と `z.enum` の値（抽出の `provenanceKind` など）は、`transformJSONSchema` が
  JSON Schema の制約としては残さず、`description` に JSON の文字列として埋め込む（`json-schema.ts` の冒頭のコメント）。
  返った JSON は `req.schema.parse` で検査するので、値が外れていれば `ZodError`（抽出なら全文フォールバック、
  `consolidate`/`reflect` なら `llm_failed`）になる。

## ⚠ 2026-09-30 追記（ADR 0428）: `signal`（abort）を直に渡したときの振る舞い

`complete` / `completeStructured` の `opts.signal` を、provider を**直に**呼んで abort すると、reject する値は
`signal.reason`（`reason` 無しの `abort()` なら `AbortError` の `DOMException`）である。SDK の `APIUserAbortError` には
ならない。呼ぶ前に abort 済みなら、SDK を呼ばず（リクエストを送らず）に reject する。SDK の再試行待ち
（429 の `retry-after` 等）の最中でも、abort で即座に打ち切られる。`signal` は SDK にも渡すので、裏のリクエストも切れる。
`signal` を渡さなければ、今までどおり返るまで待つ。失敗の判定は `isAnthropicLLMProviderError`（`kind`、無ければ `name` で見る。`kind` の値は openai と anthropic で重なるので、`name` が文字列ならそれが
`"AnthropicLLMProviderError"` であることも見る。`instanceof` を使わない）でもできる。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §3.8・§4・§5.4 — `LLMProvider` の契約と provider 構成
- [ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) — このパッケージを足した判断と、
  採らなかった案・引き受けた負債・確かめていないこと
- リポジトリ: https://github.com/takecchi/mnemora
