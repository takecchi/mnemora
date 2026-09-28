# ADR 0350: `@mnemora/openai` / `@mnemora/anthropic` の `client` の型を SDK のクラスから切り離す（Issue #1221）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `tsc`/`vitest`/`npm view` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)）

`@mnemora/openai` と `@mnemora/anthropic` は、SDK（`openai`・`@anthropic-ai/sdk`）を
`dependencies` に版を固定して持つ。公開の `*ProviderOptions.client` 欄は、その SDK の
クラスから切り出した型（`Pick<OpenAI, "chat">`・`Pick<OpenAI, "embeddings">`・
`Pick<Anthropic, "messages">`）だった。

Issue #1221 は【実測】（2026-09-27、PR #1218）として、利用者が `@mnemora/openai` の
固定版と違う版の `openai`（例: 固定 `7.10.0` に対して最新 `7.23.0`）を自分の依存として
入れ、自分で作った `OpenAI` インスタンスを `client` に渡すと、型検査が
`TS2322: Type 'OpenAI' is not assignable to type 'Pick<OpenAI, "chat">'` で落ちることを
確認している（実行はできる。原因は `RequestOptions.headers` の `NullableHeaders`
ブランドの食い違い）。`@anthropic-ai/sdk` 側も同型の症状（`Pick<Anthropic, "messages">`）
を持つ。回避策（同じ版を `-E` で入れる）は README に追記済み（PR #1218）だが、
利用者に SDK の版を固定させる負担を残す。

Issue #1221 は5案（A: 現状維持、B: `peerDependencies` 化、C: 依存のまま範囲指定、
D: peer と dependencies の併用、E: `client` の型を SDK のクラスから切り離す）を並べ、
推奨を書かずにオーナーへ判断を委ねた。

## オーナーの回答

`ask_human f259eeb8`（問1、2026-09-28）の回答は逐語で:

> 型を SDK のクラスから切り離すってのはだめですか？

⟹ **案E（`client` の型を自前の構造型にする）を採る。** `peerDependencies` 化（案B）・
範囲指定（案C）・併用（案D）は、この回答により不要になった——型さえ SDK のクラスを
名指ししなければ、依存の形（`dependencies` に完全固定のまま）を変える必要が無い。

## 決定

### 1. `client` の型を、provider が実際に呼ぶメソッドだけを持つ自前の構造型にする

各パッケージに `client-types.ts` を新設し、次の3つの構造型を export する:

- `@mnemora/openai`: `OpenAIChatClient`（`OpenAILLMProviderOptions.client` の新しい型。
  以前は `Pick<OpenAI, "chat">`）、`OpenAIEmbeddingsClient`
  （`OpenAIEmbeddingProviderOptions.client` の新しい型。以前は `Pick<OpenAI, "embeddings">`）。
- `@mnemora/anthropic`: `AnthropicMessagesClient`（`AnthropicLLMProviderOptions.client`
  の新しい型。以前は `Pick<Anthropic, "messages">`）。

持たせるのは、provider が実際に呼ぶメソッド（`chat.completions.create` /
`embeddings.create` / `messages.create`）と、実際に送る引数・実際に読む戻り値の
フィールドだけ。SDK が持つ他のメソッド・フィールドは一切持たない。

内部の `private readonly client` の型と、`@mnemora/anthropic` の `firstTextBlock` が
受け取っていた `Anthropic.Messages.ContentBlock[]` も、同じ理由で自前の
`AnthropicContentBlock[]`（`client-types.ts` 内、非 export）へ差し替えた。

`import OpenAI from "openai"` / `import Anthropic from "@anthropic-ai/sdk"` 自体は
両パッケージの実装ファイルに残る——`new OpenAI(...)`/`new Anthropic(...)` で既定の
クライアントを作るために実行時に要る（値としての import）。**だが公開する `.d.ts`
には SDK の import が一切現れない**——【実測】`pnpm --filter @mnemora/openai run build`・
`pnpm --filter @mnemora/anthropic run build` の後、`dist/llm-provider.d.ts` /
`dist/embedding-provider.d.ts` を読み、`import OpenAI from "openai"` /
`import Anthropic from "@anthropic-ai/sdk"` の行が消えていること、`client?:` の型が
`OpenAIChatClient` 等の自前の型を指すことを確認した（private フィールドはそもそも
TypeScript の宣言出力が型注釈を省略するため、`private readonly client;` は元から
型を持たない形で出力される）。

### 2. method 記法でメソッドを書き、双変な代入を意図的に利用する

`create(params: X, options?: unknown): PromiseLike<Y>` という**メソッド記法**で書く。
TypeScript はメソッド記法のプロパティのパラメータを双変（bivariant）に検査する
——`create: (params: X, options?: unknown) => PromiseLike<Y>` という arrow function
型で書くと、`strictFunctionTypes` の下でパラメータが共変のみの検査になり、実際の
SDK の overload（`stream` の有無で戻り値の型が変わる複数の signature を持つ）を実装
する実クライアントを代入できなくなる。

【実測】この双変性への依拠が実際に効くことを、`openai`（固定 `7.10.0`・別版
`7.23.0`）・`@anthropic-ai/sdk`（固定 `0.124.0`・別版 `0.129.0`）の4通りで、
`OpenAI`/`Anthropic` インスタンス全体（`Pick<...>` を含む）を新しい構造型へ代入する
式が `tsc --strict` を通ることで確認した（下記「測ったこと」・
`packages/openai/src/__tests__/client-type-compat.test.ts` /
`packages/anthropic/src/__tests__/client-type-compat.test.ts`）。

### 3. SDK は `dependencies` に完全固定のまま残す（peer にしない）

`openai@7.10.0` / `@anthropic-ai/sdk@0.124.0` を、引き続き `dependencies` に版を
固定して持つ。理由:

- **既定のクライアント生成（`new OpenAI(...)`/`new Anthropic(...)`）と、
  `@anthropic-ai/sdk/helpers/zod` の `zodOutputFormat`（`json-schema.ts`）は、
  実行時に SDK 本体を要る。** `peerDependencies` にすると、`apiKey` だけを渡して
  使う（＝SDK を自分で入れる意思の無い）利用者にも SDK を明示的に入れさせることに
  なり、install 体験を悪化させる。
- **`peerDependencies` は、範囲外の版を利用者が入れたときの実行時の責任を、
  この2パッケージの外（利用者の選んだ SDK の版）に置くことになる。** 型さえ
  切り離せば、`peerDependencies` の主目的（「型が食い違わない」）は達成できるので、
  実行時の責任分界を変えてまで peer 化する理由が無くなった。
- **install の形を変えない。** README・`scripts/check-consumer-install.mjs`・
  `pack:check` の見込みへの影響が無い（Issue #1221「案B」が挙げていた変更点が
  すべて不要になる）。

## 検討して採らなかった案

Issue #1221 が既に挙げていたものを、オーナーの回答を踏まえて整理し直す。

1. **案A（現状維持）**: 却下——利用者が `@mnemora/openai`/`@mnemora/anthropic` の
   固定版と違う版の SDK を入れると型検査が壊れる問題が残る。README の回避策
   （同じ版を `-E` で入れる）は利用者への負担であり、オーナーの回答が「型を
   切り離す」方向を明示した以上、その負担を残す理由が無い。
2. **案B（`peerDependencies` にする）**: 却下——オーナーの回答により不要になった。
   型を切り離せば peer 化の主目的（型の食い違いを消す）は達成でき、
   install の形を変える・範囲外の版の実行時責任を利用者に移す、という
   peer 化に伴うコストを払わずに済む。
3. **案C（`dependencies` のまま範囲指定、例: `^7.10.0`）**: 却下——同じ理由。
   加えて、範囲の外の版を入れられたときに今と同じ食い違いが残る余地も消せない
   （範囲指定は「重なれば畳まれることがある」だけで、型の独立性を保証しない）。
4. **案D（`peerDependencies` と `dependencies` の併用、または
   `peerDependenciesMeta.optional`）**: 却下——パッケージマネージャごとの振る舞いの
   違い（pnpm・npm・yarn）を確かめるコストに見合う利益が、型を切り離した後には
   残らない。

## 引き受けた負債

1. **公開型の破壊的変更である。** `OpenAILLMProviderOptions.client` /
   `OpenAIEmbeddingProviderOptions.client` / `AnthropicLLMProviderOptions.client` の
   宣言された型が、`Pick<OpenAI, ...>`/`Pick<Anthropic, ...>` から
   `OpenAIChatClient`/`OpenAIEmbeddingsClient`/`AnthropicMessagesClient` へ変わった。
   **`client` を渡さない利用者（`apiKey` だけ、または環境変数）は影響を受けない。**
   **`client` に SDK のインスタンスをそのまま渡している利用者も、実行時・型検査の
   どちらも影響を受けない**（構造的に代入できる。下記「測ったこと」）。**影響を
   受けるのは、`Pick<OpenAI, "chat">` 等の型注釈を自分のコードに明示的に書いている
   利用者だけ**——新しい型名（`OpenAIChatClient` 等）へ置き換える必要がある。
   `scripts/check-public-api-surface.mjs` の snapshot 更新（`pnpm api:write`）は
   この ADR の決定に基づく破壊的変更として行った。
2. **構造型が SDK の型を「実際に呼ぶ範囲だけ」手で書き写したものであり、SDK 側の
   実装が変われば手で追随する必要がある。** 例えば OpenAI が
   `chat.completions.create` の必須引数を将来増やせば、この構造型は追随しない限り
   「実際に SDK が要求する形」より緩いままになる——ただし、それは provider 自身の
   実装（`llm-provider.ts` が実際に組み立てて送る object リテラル）が SDK の要求を
   満たさなくなる問題であり、型を切り離す前（`Pick<OpenAI, "chat">` を使っていた
   とき）から存在した性質と同じである（`Pick` も「SDK の今の型」を映すだけで、
   将来の版の要求を先取りしない）。
3. **メソッド記法の双変性への依拠は、TypeScript の既知の「穴」（意図的な設計だが
   健全ではない）を前提にしている。** 将来 TypeScript が `strictFunctionTypes` の
   対象をメソッド記法にも広げれば（過去に議論はあるが採用されていない）、この設計は
   実際の SDK インスタンスを受け付けなくなる可能性がある。歯
   （`client-type-compat.test.ts`）が typecheck の一部として走るため、そうなれば
   CI の `pnpm run typecheck` が赤くなって気づける。

## これが覆るとしたら

- TypeScript がメソッド記法の双変性を廃止する（`strictFunctionTypes` の対象を
  広げる）版を出し、この設計が実際の SDK インスタンスを受け付けなくなったとき。
  そのときは、構造型をより緩く（`options?: unknown` を可変長引数にする等）書き直す
  か、SDK の型を条件型で緩める設計へ切り替える必要がある。
- SDK 側が `chat.completions.create`/`embeddings.create`/`messages.create` の
  シグネチャを、この構造型と互換性が無い形へ大きく変えたとき（引数の意味が変わる
  等）。そのときは構造型自体を書き直す。
- `peerDependencies`化の主目的が変わり（例: バンドルサイズの都合で SDK を利用者に
  持たせたい等）、型の独立性以外の理由で peer 化が要ると判断されたとき。

## 測ったこと

- **【実測】npm 上の実在確認と版の選定（2026-09-29）**: `npm view openai version` →
  `7.23.0`、`npm view @anthropic-ai/sdk version` → `0.129.0`。両方を devDependency に
  `"openai-latest": "npm:openai@7.23.0"` / `"anthropic-sdk-latest": "npm:@anthropic-ai/sdk@0.129.0"`
  としてエイリアスし、`pnpm install --no-frozen-lockfile` でロックファイルを更新した
  （`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` に `@anthropic-ai/sdk@0.129.0`
  が自動で追加された——pnpm の供給網ポリシーが「リリースから十分な時間が経っていない
  版」を既定で警戒するためで、意図的に最新を選んだ今回はこれを許可する形になる）。
- **【実測】型の代入可能性**: `packages/openai/src/__tests__/client-type-compat.test.ts`
  ・`packages/anthropic/src/__tests__/client-type-compat.test.ts` が、固定版
  （`openai@7.10.0`・`@anthropic-ai/sdk@0.124.0`）と別版（`openai-latest`＝`7.23.0`・
  `anthropic-sdk-latest`＝`0.129.0`）の両方の SDK インスタンス（`Pick<...>` 型を含む）
  を、新しい構造型の変数へ代入する行を持ち、`pnpm --filter @mnemora/openai run
  typecheck` / `pnpm --filter @mnemora/anthropic run typecheck`
  （＝`tsc -p tsconfig.json`）がどちらも無エラーで通ることを確認した。
- **【実測】実際の呼び出しが変わっていないこと**: 同じ2つの歯が、`fetch` を
  差し替えた本物の SDK client（固定版・別版それぞれ）を provider へ渡し、
  `OpenAILLMProvider.complete`/`OpenAIEmbeddingProvider.embed`/
  `AnthropicLLMProvider.complete`/`completeStructured` を実際に呼んで、送られる
  URL・HTTP method・JSON body が変更前と同じ形であることを確認した
  （`vitest run` で全件緑。件数は歯自身が持つ——ここには写さない）。
- **【実測】公開 `.d.ts` に SDK の import が残っていないこと**: 両パッケージを
  `build` した後の `dist/llm-provider.d.ts`・`dist/embedding-provider.d.ts` を読み、
  `import OpenAI from "openai"`/`import Anthropic from "@anthropic-ai/sdk"` の行が
  無く、`client?:` の型が自前の構造型を指すことを確認した。
- **【実測】変異試験** （詳細な手順・赤/緑の実測は PR 本文に記載。`cp` で退避・復元し、
  `git checkout` は使っていない）:
  1. `OpenAIChatCompletionCreateParams` に SDK に無い必須引数を足す →
     `client-type-compat.test.ts` の代入行が `tsc` で赤くなり、戻すと緑に戻った。
  2. provider が実際に送るフィールド（`model`）を1つ変える →
     call-shape のテストが実測値の不一致で赤くなり、戻すと緑に戻った。
  3. 公開の `.d.ts` に SDK の型を戻す相当の変更（`client` の型を
     `Pick<OpenAI, "chat">` に戻す）→ `scripts/check-public-api-surface.mjs` が
     snapshot との差分を検出して赤くなり、戻すと緑に戻った。

## 確かめていないこと

- **yarn（classic・berry）での振る舞い。** Issue #1221 が最初から「確かめていない
  こと」に挙げていた点で、この ADR でも追加調査していない。
- **TypeScript の将来の版でメソッド記法の双変性が廃止された場合の具体的な挙動。**
  「これが覆るとしたら」に書いた仮定であり、実際に試していない。
- **実際の OpenAI/Anthropic API に対して、新しい構造型を経由した呼び出しが
  意図どおりに動くこと。** この ADR の歯は `fetch` を差し替えた偽の応答で検査して
  おり、本物の API への到達性は `live.openai.test.ts`/`live.anthropic.test.ts`
  （API キーがある場合のみ）の役目のままで、この PR では新たに実行していない。
