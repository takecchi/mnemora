# ADR 0609: マージ済み #1377（client の型を SDK のクラスから自前の構造型へ切り離した。ADR 0350）の確かめ直しで見つかった穴を塞ぐ（openai の temperature・anthropic の system・公開 .d.ts の SDK import・stop_details の型）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-955ee40f）の指示で書いた。歯を書くと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0607](./0607-merged-pr-0928-recheck-teeth.md) などの試験だけの PR と同じ）。実装コードは変えず、`packages/openai/src/client-types.ts` の TSDoc の文面だけ直した。

## 経緯【実測】

マージ済みの #1377（`OpenAILLMProviderOptions.client` などの型を、`openai`・`@anthropic-ai/sdk` のクラスから切り離した自前の構造型にした。[ADR 0350](./0350-provider-client-type-decoupled-from-sdk-classes.md)）を、main `dfa1f599` で確かめ直した、という指示をクローンから受けた。次の穴が、既存の歯のどれにも捕まらなかった（指示の文言どおり。この PR の担い手は、新しい歯を足す前の既存の歯に全部の変異を当て直してはいない）。

| 穴 | 内容 |
| --- | --- |
| openai の `temperature` | 既存の送る形の歯は `temperature` を指定しない呼び出ししか見ていなかった。`complete` が `temperature` を落としても、未指定でも `temperature: undefined` などを入れても、どちらも緑だった（実 SDK を通す歯は `toEqual` で、`undefined` の鍵を区別しない） |
| anthropic の `system` | 既存の歯は `prompt.system` を渡す呼び出しを持たなかった。`complete` が `system` を送らなくても緑だった |
| 公開 `.d.ts` の SDK import | `packages/openai/src/client-types.ts` の TSDoc は「`__tests__/client-type-compat.test.ts` の grep が縛る」と書いていたが、その grep は実在しなかった【現物】 |
| `stop_details` の型 | `AnthropicMessageResult` から `stop_details` を消しても、実 SDK の `Message` は `stop_details` を持つので代入の歯は緑のまま。`assertNotRefusedOrTruncated` の引数は欄が全部任意の型で、消えても通る。typecheck が落ちる道が無かった |

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は `packages/openai`・`packages/anthropic` の `src/__tests__/client-type-compat.test.ts` に足す（既存の送る形の歯の並びに倣う）。
2. **openai の temperature**: 偽の `OpenAIChatClient` を作り、`create` に渡された引数をそのまま積む（SDK の直列化を挟まない）。
   - `temperature: 0.2` で作って `complete` を呼ぶと、引数の `temperature` が `0.2`。
   - 指定しなければ、`"temperature" in body` が `false`（鍵そのものが無い）。
3. **anthropic の system**: 偽の `AnthropicMessagesClient` で、`prompt.system` 付きの `complete` の引数の `system` がその値（`messages` には入らない）。`prompt.system` を渡さないときは `"system" in body` が `false`。後者は `toAnthropicRequest` の TSDoc（「無ければ鍵ごと無い」）が既に約束しているので、縛ってよいと判断した【判断】。
4. **公開 `.d.ts` に SDK の import が出ない（両パッケージ）**: 次の5つの綴りを、1行ずつ見る。直前に引用符を置くので `@mnemora/openai` や `./openai.js` には当たらない。
   - `from "<SDK>"`（`import`・`export` の `from`）
   - `import "<SDK>"`
   - `import("<SDK>")`（型の位置の動的 import）
   - `require("<SDK>")`
   - `/// <reference types|path="<SDK>" />`

   `<SDK>` は openai では `openai`・`openai-latest`（devDependency のエイリアス）とその下位パス、anthropic では `@anthropic-ai/sdk`・`anthropic-sdk-latest` とその下位パス。TSDoc の散文に SDK の名前が出るのは（`.d.ts` のコメントに残るが）当たらない綴りなので、偽陽性にならない。
   - **探り棒の陽性対照**: 当たるべき綴り7通り・当たってはいけない綴り（自パッケージ名・相対パス・名前が前方一致するだけのもの）8〜9通りを、別の it で確かめる。
5. **grep を CI で効かせる方法**【現物・実測】: `.github/workflows/ci.yml` の `typecheck / lint / test / build` ジョブは `pnpm run test` を `pnpm run build` より前に走らせる。`packages/openai/vitest.config.mts` も同じことを書いている。`dist` を読む形にすると、CI の `test` の時点では読めるファイルが0本で、黙って通る。そこで、この歯は `dist` を読まず、**`tsconfig.build.json` と同じ設定（テストを除く `src`、`declaration`）で TypeScript の API が `.d.ts` をメモリへ出したものを読む**。`@mnemora/core` だけは `dist` が無いので `core/src` を指させる（`.d.ts` の中の綴りは `@mnemora/core` のまま）。出たファイルに `index.d.ts`・`client-types.d.ts`・`llm-provider.d.ts` が無いとき、`client-types.d.ts` に構造型の名前が無いときは落とす（「無かった」を根拠にしない）。**dist を build するかどうかに関わらず、同じ結果になる**（実 dist の `.d.ts` も、変異の後で build して grep し、同じ行が出ることを確かめた）。
   - 代わりに採らなかった案: (a) `dist` が在れば読み、無ければ読み飛ばす（黙って通る穴そのもの）。(b) `ci.yml` に `build` の後の専用ステップを足す（ジョブ名が branch protection の文脈名で凍っており、ステップを足すと CI の設定が増える。試験の中で閉じるほうが、手元の `vitest` でも同じ歯が効く）。
   - 引き受ける負債: 試験の中で `ts.createProgram` を走らせるので、1回あたり約2.5秒かかる【実測】。`tsconfig.build.json` を `core/src` の指し方まで再現しているので、`tsconfig.build.json` の `exclude` や `compilerOptions` が大きく変わったら、この歯も直す。
6. **`stop_details` の型**: `AnthropicMessageResult["stop_details"]` の `category` の型が `string | null | undefined` と同一であることを `Expect<Equals<...>>`（`schema-type-equals-parity.test.ts` と同じ型だけの表明）で縛る。`stop_details` を消すと `TS2339`。加えて、`stop_details: { category }` を持つ値を `AnthropicMessageResult` として宣言する it を置く（消すと `TS2353`）。typecheck（`tsc -p tsconfig.json`）の `include` は `src` で、`__tests__` を含む【現物】。
7. TSDoc: `packages/openai/src/client-types.ts` の「歯は …の grep」を、実在する describe の名前と、`dist` を読まず build の設定でメモリへ出すことを書いた文面に直した。`packages/anthropic/src/client-types.ts` には grep を名指す文面が無いので、触っていない。

## 変異試験【実測】

対象ファイルを `cp` で `/tmp/mgr-955ee40f-1377-bak/` へ退避し、変異を Edit で入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、緑に戻ることを確かめた。

| 歯 | 変異（側） | 結果 |
| --- | --- | --- |
| openai temperature | `complete` が `temperature` を送らない（足りない） | 赤 1本（`temperature: 0.2` の歯） |
| openai temperature | `complete` が `temperature: this.temperature` を常に入れる（やりすぎ。未指定なら `undefined`） | 赤 1本（鍵が無い歯） |
| openai temperature | `complete` が `temperature: this.temperature ?? 1` を常に入れる（やりすぎ。既定値） | 赤 3本（鍵が無い歯と、既存の実 SDK を通す body の `toEqual` 2本） |
| anthropic system | `complete` が `system` を送らない（足りない） | 赤 1本（`system` の値の歯） |
| anthropic system | `complete` が `system: ""` を送る（値を変える） | 赤 1本（`system` の値の歯） |
| anthropic system | `complete` が `system: system ?? ""` を常に入れる（やりすぎ） | 赤 3本（鍵が無い歯と、既存の実 SDK を通す body の `toEqual` 2本） |
| openai .d.ts | `client-types.ts` に `import type OpenAIMutant from "openai"` と、それを使う export を足す | 赤 1本（`client-types.d.ts: import type OpenAIMutant from "openai";`）。`dist` を build し直した `.d.ts` にも同じ行が出ることを確認。戻して build し直し、緑 |
| anthropic .d.ts | `client-types.ts` に `import type AnthropicMutant from "@anthropic-ai/sdk"` と、それを使う export を足す | 赤 1本（同様）。`dist` にも同じ行が出ることを確認。戻して build し直し、緑 |
| stop_details | `AnthropicMessageResult` から `stop_details` を消す（足りない） | tsc 赤 3件（`TS2339` 1件・`TS2353` 1件・`TS2339` 1件。どれも新しい歯の側。実装側の typecheck は通った） |
| stop_details | `stop_details` を必須にする（やりすぎ） | tsc 赤 1件。ただし落ちたのは新しい型の表明ではなく、`system` の歯の偽 client（`stop_details` を返さない）の代入（`TS2322`）。`Equals` の表明と宣言の it は緑のまま。**型の歯としては約束の外**（必須にしても `Equals` は動かない）で、赤になったのは偽 client が副次的に「欄を返さない最小の client を代入できる」ことを縛っているため |

どの変異も、戻したあとは同じ歯が緑に戻り、対象ファイルは変異の前と同一（`cmp`）。

## 縛っていないもの

- 最小の偽 client（欄を最小限しか返さない client）を構造型へ代入できること。上の表のとおり、`stop_details` を必須にすると `system` の歯の偽 client が代入できなくなって tsc が落ちるが、それは副次的で、意図して縛っていない【判断】。
- `complete` の戻り値の `any` 化、`index.ts` の export 漏れ。`pnpm run api:check`（`scripts/check-public-api-surface.mjs`）だけが捕まえるもの。
- `temperature: 0` を渡したときの扱い（`this.temperature !== undefined` を truthy 判定に変える変異）は入れていない。`completeStructured` の `temperature`、anthropic の `completeStructured` の `system` は縛っていない（`complete` だけを見た）。
- `role: "system"` のメッセージが top-level の `system` へ連結される挙動は、`toAnthropicRequest` の別の歯の範囲で、この PR では見ていない。
- `.d.ts` の grep は、`import` の綴りを5つ見るだけである。SDK の型を別の形（`/// <reference lib>`・`declare module "openai"` など）で出す経路や、SDK の名前を型として直書きする経路は見ない。SDK 以外のパッケージ（`zod`・`@mnemora/core`）の import は、この歯の対象外。`dist` に出る `.js`・`.js.map` も見ない。
- grep は `ts.createProgram` の出力を読むので、`tsc -p tsconfig.build.json` を実際に走らせた `dist` と、`@mnemora/core` の解決先（`core/src`）が違う。違いは `.d.ts` の中の綴りには出ないと見ているが、全ファイルで差分を取って確かめてはいない（変異の後で、メモリへ出した `.d.ts` と実 dist の `.d.ts` の両方に同じ import の行が出たことだけ確かめた）。

## これが覆るとしたら

ADR 0609 が縛った約束（`temperature` を指定したときだけその値で送ること、`system` を `prompt.system` から top-level へ送り、無ければ鍵ごと無いこと、公開 `.d.ts` に SDK の import が出ないこと、`stop_details.category` を構造型に持つこと）が変わるとき。とくに、`temperature` や `system` を未指定でも既定値で送ると決めるなら、決めるのはオーナーである。`ci.yml` が `build` を `test` の前に走らせるようになれば、grep を `dist` から読む形に戻してよい。
