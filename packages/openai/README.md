# @mnemora/openai

`EmbeddingProvider` / `LLMProvider` の OpenAI 実装。zod スキーマを OpenAI の
Structured Output（`response_format: json_schema`）へ翻訳する
（[docs/architecture.md](../../docs/architecture.md) §3.8）。

## インストール

```bash
pnpm add @mnemora/openai @mnemora/core zod
# または
npm i @mnemora/openai @mnemora/core zod
```

下の例は `completeStructured` に渡すスキーマを `zod` で作るので、`zod`（`@mnemora/core` と同じメジャー、^4.5.4）も自分の依存として入れる（2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れて確かめた。npm は依存の `zod` を hoist するので `zod` を足さなくても動くことがあるが、pnpm のような厳格な配置では `Cannot find package 'zod'` で止まる）。

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `module`/`moduleResolution` を `nodenext` にし、TypeScript 5.8 以降を使うこと。
  5.7 以前の `nodenext` と、どの版の `node16` も `TS1479` になる。`node10` は TypeScript 5.x なら
  パッケージの入口の型を解決できるが、`exports` を読まないので `@mnemora/testkit/fixtures` のような
  subpath は解決できず、TypeScript 6 で非推奨・7 で廃止された。2026-09-27 に TypeScript 5.0〜7.0 で実測）
- **`OPENAI_API_KEY` 環境変数**（または `apiKey` オプション）が要る。無いと、**呼び出す前に、`new OpenAIEmbeddingProvider(...)`・
  `new OpenAILLMProvider(...)` の時点で** OpenAI SDK が `OpenAIError: Missing credentials. ...` を投げる
  （`OpenAILLMProviderError` ではなく、`kind` も持たない）【実測 2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れ、ネットワークを切って走らせた】
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

## ⚠ 2026-09-30 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)）: `embed()` は応答を検査する（下の 2026-09-26 の節は古くなった）

`OpenAIEmbeddingProvider.embed` は、応答が次のどれかを満たさなければ、素の `Error`（メッセージは
`OpenAIEmbeddingProvider:` で始まる。専用のエラー型・`kind` は無い）を投げる: (1) `response.data` の件数が
入力の件数と等しい、(2) `index` が 0..n-1 をちょうど1回ずつ、(3) 各ベクトルの長さが `dimensions` と等しい、
(4) 成分がすべて有限（`NaN`/`Infinity` が無い）。メッセージには期待値・実際の値・何番目かを入れ、入力テキストの
本文と API キーは入れない。**新しく例外になる場合が増える変更**で、[CHANGELOG.md](../../CHANGELOG.md) の
`[1.2.0]` に破壊的変更として書いた（`response.data` キー自体が無い応答は従来どおり生の `TypeError`）。
入力の上限超過は今もサーバの拒否に依存している（[ADR 0305](../../docs/decisions/0305-embedding-provider-input-limit-contract.md)）。
実 API がこれらの食い違いを実際に返すかは確認していない（偽の `fetch` を本物の SDK に渡して確かめた）。

## ⚠ 2026-09-26 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)）: `embed()` は応答の件数を確かめない（⚠ 2026-09-30 に古くなった。当時の記述として残す）

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

⚠ 2026-09-27 追記: この例は `openai` を自分の依存として入れないと動かない（pnpm では `Cannot find package 'openai'`）。

🔴 **2026-09-29 訂正（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)、[ADR 0350](../../docs/decisions/0350-provider-client-type-decoupled-from-sdk-classes.md)）: 上の「同じ版を入れること」はもう要らない。** `client` の型は `Pick<OpenAI, "chat">`/`Pick<OpenAI, "embeddings">`（`openai` パッケージのクラスをそのまま切り出した型）から、`@mnemora/openai` 自前の構造型（`OpenAIChatClient`/`OpenAIEmbeddingsClient`、`openai` パッケージの型を一切参照しない）へ変わった。**`openai` を自分の依存として入れる版は、`@mnemora/openai` が固定している版（`7.10.0`）と揃える必要が無い**——`pnpm add openai`・`npm i openai` で最新を入れても、`OpenAI` インスタンスはそのまま `client` に渡せる（版ごとの `RequestOptions`/`NullableHeaders` の食い違いは、構造型が SDK のクラスを名指ししなくなったことで解消した）。旧型 `Pick<OpenAI, "chat">`/`Pick<OpenAI, "embeddings">` を自分の型注釈にそのまま書いていても、`OpenAI`/`OpenAIChatClient` の代入関係は壊れていない——ただし公開の宣言自体を指す型注釈（例: 独自の偽 client の型を `OpenAILLMProviderOptions["client"]` から `typeof` で取り出す等）は新しい型名を参照するよう直すこと。移行の詳細は [CHANGELOG.md](../../CHANGELOG.md) の `[1.1.0]` 節を見ること。

## ⚠ 2026-09-27 追記: `embed()` に渡せる入力の境界（実 API で当てた、今の振る舞い）

`OpenAIEmbeddingProvider.embed` は、入力を検査せずにそのまま `embeddings.create` へ1回で渡し（`dimensions` は常に付く）、
OpenAI のサーバが拒めば、その例外（SDK の `BadRequestError`、HTTP 400）がそのまま伝わる。どれも mnemora の約束として
決めた値ではなく、OpenAI のサーバの振る舞いである（サーバが変われば変わりうる）。

【実測 2026-09-27、`text-embedding-3-small`、`openai@7.10.0`、各1回】

| 入力                                                                    | 結果                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空文字 `""`                                                             | 400「`input cannot be an empty string`」。**1件でも空文字が混ざると、そのバッチ全体が失敗する**（`["a", ""]` も 400）                                                 |
| 空白だけ（`" "`）                                                       | ベクトルが返る                                                                                                                                                        |
| 上限（8192 トークン）を超える入力                                       | 400「`maximum input length is 8192 tokens`」（`dimensions` 付きの呼び出しでも同じ、[ADR 0305](../../docs/decisions/0305-embedding-provider-input-limit-contract.md)） |
| 1回に 2049 件以上                                                       | 400「`array length must be 2048 or less`」（2048 件は通る）。**分割はしない**                                                                                         |
| `dimensions` がモデルの上限を超える（`text-embedding-3-small` に 1537） | 400「`Must be less than or equal to 1536`」。**構築時には分からず、最初の `embed()` で分かる**                                                                        |
| 並び順                                                                  | 応答の `index` は入力の順（`[0,1,2]`）で、同じ入力には同じベクトルが返った。`embed` は `index` で並べ直して返す                                                       |

mnemora の runtime は、recall のクエリを trim して空なら埋め込まず、embed ジョブは1件ずつ渡すので、
空文字の recall と 2049 件以上は runtime からは起きない。**ただし Memory の本文（`content`）や
`RuntimeDeps.embeddingInput` の戻り値が空文字だと、その embed ジョブは 400 で失敗する**
（`@mnemora/local-embedding` は空文字にもベクトルを返す——provider で振る舞いが違う）。

## ⚠ 2026-09-27 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)）: `completeStructured` に渡せる zod の形（当時の振る舞い。2026-09-29 に変えた——下の追記を見ること）

【実測 2026-09-27、`gpt-4o-mini`、`openai@7.10.0`、各形1回】**当時**は、`OpenAILLMProvider.completeStructured` が渡された zod
スキーマを翻訳して**そのまま送っており**、送る前に「OpenAI が受け付ける形か」を検査していなかった。受け付けない形は、送った後に
OpenAI が拒み、SDK の `BadRequestError`（HTTP 400、`type: invalid_request_error`、`param: response_format`）がそのまま伝わっていた
（`OpenAILLMProviderError` の `kind` には入らなかった）。

| zod の形                                                                 | 結果（2026-09-27 当時）                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `z.object`・`z.array`・`z.enum`・`optional`・`nullable`（core が使う形） | 通る（core の4つのスキーマは実 API で確かめた、#1164）     |
| 根が union（判別可能ユニオンなど）                                       | 通る（1つの欄 `result` を持つ object に包んで送る、#1147） |
| `z.lazy`（再帰）                                                         | 通る                                                       |
| `default`                                                                | 通る                                                       |
| `z.record`                                                               | 400「`'propertyNames' is not permitted`」                  |
| `z.tuple`                                                                | 400「`array schema items is not an object`」               |
| `z.date`                                                                 | 400「`schema must have a 'type' key`」                     |
| `transform`                                                              | 400「`schema must have a 'type' key`」                     |

⚠ 2026-09-28 追記: 「根が union」と「`z.lazy`（再帰）」は別々に通ったが、**根の union が自分自身を再帰で含む形**
（子に根の union を持つ）は、包むときに根を指す参照（`$ref: "#"`）を書き換えないので、子の参照が包みの object
（`{ result: … }`）を指す——送る形が元のスキーマと変わる（翻訳の結果で確かめた。実 API には当てていない）。
core の4つのスキーマはこの形を使わない。歯は `src/__tests__/structured-root-union.test.ts`。

拒まれたときの文面はスキーマの位置だけで、プロンプトの本文と API キーは載らなかった（確かめた）。

### 🔴 2026-09-29 訂正（[ADR 0360](../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）: 送る前に検査するようになった

**上の「送る前には検査しない」はもう成り立たない。**`completeStructured` はいまや、実際に送る JSON Schema を **`chat.completions.create`
を呼ぶ前に**、`openai` SDK 自身の strict 変換 `toStrictJsonSchema`（`openai/lib/transform`。戻り値は使わず、検査のためだけに呼ぶ
——送るのは今までどおり mnemora 自身の翻訳結果である）に通す。加えて、翻訳そのもの（`z.toJSONSchema`）も zod の既定（`unrepresentable`
省略＝ throw）で行うようになった（以前は `unrepresentable: "any"` を渡し、`z.date()`・`transform` を型の無いスキーマとして黙って
送っていた）。

| zod の形 | いまの結果（2026-09-29 以降） |
| --- | --- |
| `z.object`・`z.array`・`z.enum`・`optional`・`nullable`（core が使う形） | 通る（変わらない） |
| 根が union（判別可能ユニオンなど）・`z.lazy`（再帰）・`default` | 通る（変わらない） |
| `z.record` | **送る前に** `OpenAILLMProviderError`（`kind: "schema_unsupported"`）——`toStrictJsonSchema` が `must set additionalProperties: false` で投げる |
| `z.tuple` | **送る前に** `OpenAILLMProviderError`（`kind: "schema_unsupported"`）——`toStrictJsonSchema` が `unsupported keyword prefixItems` で投げる |
| `z.date` | **送る前に** `OpenAILLMProviderError`（`kind: "schema_unsupported"`）——zod 自身が `Date cannot be represented in JSON Schema` で投げる |
| `transform` | **送る前に** `OpenAILLMProviderError`（`kind: "schema_unsupported"`）——zod 自身が `Transforms cannot be represented in JSON Schema` で投げる |

どの場合も `chat.completions.create` は呼ばれず、元の例外は `OpenAILLMProviderError.cause`（ES2022 の `Error.cause`）に載る。
**上の 2026-09-27 の実測（実 API が 400 で拒む）は、いまは踏まない経路になった**——記録として残すが、現物の振る舞いはこの節が正。
**確かめていないこと**: `toStrictJsonSchema` が拾わない、実 API だけが拒む形（今回の4形には無かった）が他にあるかは分からない
——この歯は「OpenAI SDK 自身の strict 検査を通るか」までしか保証しない。歯は `src/__tests__/structured-output-zod-shapes.test.ts`・
`src/__tests__/core-schemas-send-shape.test.ts`。`@mnemora/anthropic` は `z.tuple`・`z.date`・`transform` を同じ形
（`kind: "schema_unsupported"`、`cause` 付き）で送る前に落とすが、`z.record` は今までどおり送る（あちらの README）。

### 戻りの `null` の扱い（2026-09-28 追記）

strict への翻訳は `.optional()` の欄を「必須 + `null` 許容」にして送るので、戻りの `null` は次のように読む。

| スキーマの位置 | モデルが `null` を返したとき |
| --- | --- |
| `.optional()` の欄 | 省略（キーが無い）として返る |
| 必須の `.nullable()` の欄・`.nullable()` の配列の要素・根の `.nullable()` | `null` のまま返る |
| `.nullable().optional()` の欄 | 省略として返る（`null` のままにはならない。[Issue #1082](https://github.com/takecchi/mnemora/issues/1082)——翻訳が足した `null` と区別できないため） |

⚠ 以前は、上の表の2行目の `null` も消していたので、`nullable` の欄は `ZodError` になっていた（上の表の「通る」は送る側の話だった）。
いまは、`null` を消して検査して落ちたときだけ、スキーマが許す `null` を残して検査し直す（通る入力の結果は変えず、それでも落ちれば最初の
`ZodError` を投げる）。union の枝ごとに扱いが割れる欄の `null` は消す側に倒す。`@mnemora/anthropic` は `null` をそのまま検査する。
歯は `src/__tests__/structured-nullable-roundtrip.test.ts`。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §3.8・§5.4・§5.5 — `LLMProvider` / `EmbeddingProvider` の契約
- [ADR 0019](../../docs/decisions/0019-real-openai-measurement-cost.md) — 本物の OpenAI を使った計測のコスト
- [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) — 本物の provider と記録・擬似 provider の使い分け
- リポジトリ: https://github.com/takecchi/mnemora
