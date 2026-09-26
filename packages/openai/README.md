# @mnemora/openai

`EmbeddingProvider` / `LLMProvider` の OpenAI 実装。zod スキーマを OpenAI の
Structured Output（`response_format: json_schema`）へ翻訳する
（[docs/architecture.md](../../docs/architecture.md) §3.8）。

## インストール

```bash
pnpm add @mnemora/openai @mnemora/core
# または
npm i @mnemora/openai @mnemora/core
```

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `moduleResolution` が `node10` か
  `nodenext` なら通る。`node16` は `TS1479` になるので `nodenext` にすること）
- **`OPENAI_API_KEY` 環境変数**（または `apiKey` オプション）が要る。無いと OpenAI SDK の
  呼び出しが認証エラーになる
- 1つの `OpenAIEmbeddingProvider` インスタンスは1つの埋め込み空間（`provider`/`model`/`dimensions`の組）に固定される。次元をモデルに応じて動的に変える使い方はできない

## 動く最小の例（型検査のみ確認・OPENAI_API_KEY が無いため未実行）

```ts
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import { z } from "zod";

// apiKey を省略すると OPENAI_API_KEY 環境変数を読む。
const embeddingProvider = new OpenAIEmbeddingProvider({
  model: "text-embedding-3-small",
  dimensions: 1536,
});

const llmProvider = new OpenAILLMProvider({ model: "gpt-4o-mini" });

const ctx = { tenantId: "tenant-1" };

const [vector] = await embeddingProvider.embed(ctx, ["hello world"]);
console.log(vector?.length); // 1536

const response = await llmProvider.complete(ctx, {
  messages: [{ role: "user", content: "こんにちは" }],
});
console.log(response.content);

// zod スキーマを渡すと、OpenAI の Structured Output 経由で検証済みの値が返る
// （core・呼び出し側に OpenAI SDK の型は一切出てこない）。
const schema = z.object({ summary: z.string() });
const structured = await llmProvider.completeStructured(ctx, {
  prompt: { messages: [{ role: "user", content: "要約して" }] },
  schema,
});
console.log(structured.summary);
```

`EmbeddingProvider.embed` / `LLMProvider.complete` / `LLMProvider.completeStructured` の
契約（`core` 側の interface）は [`@mnemora/core`](../core/README.md) を参照。
`createRuntime()` にそのまま渡して使う例は [`@mnemora/postgres`](../postgres/README.md) の
README にある。

## ⚠ 失敗は種類として返る（拒否を「空の成功」にしない）——ただし応答の形そのものが壊れている場合は別

**OpenAI の拒否は HTTP 200 で返る。**`message.refusal` に拒否理由の文字列が入り、
このとき `message.content` は `null` になる。SDK は例外を投げない。
`LLMProvider.complete`/`completeStructured` は `content` を読む前にこれを見て、
`OpenAILLMProviderError` を `kind: "refusal" | "truncated" | "no_content"` として
投げる（`src/errors.ts` 参照。`@mnemora/anthropic` の `kind` タクソノミーと対になる形）。

**⚠ 2026-09-26 追記（Issue #885）: `kind` が表すのはこの3種のどれかである。** HTTP 200
の応答オブジェクトそのものの形が壊れている場合——`chat.completions.create` の
`choices` や `embeddings.create` の `data` がトップレベルからキーごと丸ごと無い場合
（`{}` が返る等）——は、`kind` の**外**にある生の例外（`TypeError` 等。壊れた JSON の
`SyntaxError`・スキーマ不適合の `ZodError` と同じ扱い）がそのまま伝播する。
`OpenAILLMProviderError` にはならず、`instanceof` でも `kind` でも捕まえられない
（埋め込み側の `OpenAIEmbeddingProvider.embed` はそもそも専用のエラー型を持たず、
壊れた応答は最初から生の例外がそのまま伝播する）。実 API がこの形を実際に返すかは
確認していない（詳細は
[ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) の同日付追記）。

## ⚠ 2026-09-26 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)）: `embed()` は応答の件数を確かめない

`EmbeddingProvider.embed` の契約は「入力と同じ件数・同じ順序でベクトルを返す」ことだが、
`OpenAIEmbeddingProvider.embed` はこれを実行時に確かめない。`response.data` を `index` で
並べ替えて返すだけで、件数が `texts.length` と食い違っていないかは検査しない
——`@mnemora/local-embedding` の `LocalEmbeddingProvider.embed` は件数・次元の食い違いを
検査して例外を投げるが、こちらは OpenAI のサーバが正しい件数を返すことに依存している
（上限超過を「サーバの拒否に依存する」のと同じ形、[ADR 0305](../../docs/decisions/0305-embedding-provider-input-limit-contract.md)）。
応答の件数が食い違ったときの戻り値は未定義である。`packages/core` の本番経路は常に
1件ずつ渡すため、この食い違いは踏まれていない。

## ⚠ 2026-09-26 追記（[Issue #884](https://github.com/takecchi/mnemora/issues/884)）: `client` を省略すると SDK 既定の再試行・timeout が効く

`client` を省略した `OpenAILLMProvider`/`OpenAIEmbeddingProvider` は `new OpenAI({ apiKey })`
が作る SDK 既定のクライアントを使う——**このクライアント自身が 429・5xx 等を内部で
再試行する**（実測: `openai@7.10.0` は既定 `maxRetries: 2`＝最大3回・`timeout: 600000`ms）。
`LLMProvider`/`EmbeddingProvider` の「自体はリトライを内蔵しない」は、mnemora の provider
コードが再試行を書いていない、という意味であり、SDK が裏で再試行しないという意味ではない。
この数値は SDK の既定値であり mnemora の契約ではないので、SDK の版が上がれば変わりうる。
再試行の回数・timeout を変えたい場合は、自分で作った `OpenAI` インスタンスを `client` に
渡す:

```ts
import OpenAI from "openai";
import { OpenAILLMProvider } from "@mnemora/openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 60_000 });
const llmProvider = new OpenAILLMProvider({ model: "gpt-4o-mini", client });
```

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §3.8・§5.4・§5.5 — `LLMProvider` / `EmbeddingProvider` の契約
- [ADR 0019](../../docs/decisions/0019-real-openai-measurement-cost.md) — 本物の OpenAI を使った計測のコスト
- [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) — 本物の provider と記録・擬似 provider の使い分け
- リポジトリ: https://github.com/takecchi/mnemora
