# ADR 0266: `LLMProvider` の適合 suite を新設し、`@mnemora/anthropic` と `@mnemora/openai` の両方に当てる（Issue #389）

- **状態**: 採用 (2026-09-23)
- **日付**: 2026-09-23

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 / 0192 / 0196 / 0198 の体裁を踏む）。

- **【実測】** — この書き手が自分の手で `vitest`/`tsc`/`eslint`/`prettier` 等を走らせて確かめた。
- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。

---

## 問い

`packages/core/src/interfaces/llm-provider.ts` が「契約:」として逐語で書いている条項を、
**実装を問わず同じ歯で**検査できるか。できるなら、`@mnemora/anthropic`（publish 6本の1つ
でありながら、これまで適合テストに1本も当たっていなかった実装、Issue #389）と
`@mnemora/openai` に実際に当てられるか。

---

## 文脈

### 「suite を作らない」は却下ではなく射程外だった

[ADR 0072](./0072-anthropic-llm-provider.md) は `@mnemora/anthropic` を足す際、provider 向け
適合テストの新設を**その場では却下し**、負債1として残した——理由は「LLM は非決定的なので、
同じ出力を要求できない」。

[ADR 0198](./0198-llm-provider-call-failure-tooth.md) は Issue #389 の一部（「呼び出し自体が
失敗したときに、例外を同一性のまま伝播し、リトライしない」という1行）だけを先に測ったが、
**suite そのものの新設は「採らなかった案A」として明示的に見送っている**——
「案A: `packages/testkit` に `describeLLMProviderConformance` を新設し、そこへ置く。⛔ 採らない。
それが Issue #389 の本体であり、本文が『⛔ 先に決めるべきこと（実装の前に）』として3つの
未決を挙げている」。

**⟹ どちらも「suite を作るべきではない」という結論ではない。**ADR 0072 は決定性の扱いという
設計判断が未解決だったため、ADR 0198 は「1つの PR は1つの ADR とその実装」
（`docs/autonomy.md` §2）に従って射程を1行に絞ったため、それぞれ**先送り**にしていた。
本 ADR はその先送りを引き取る。

### ADR 0095 が同じ形の設計判断を先に解いていた

[ADR 0095](./0095-embedding-provider-conformance.md) は `EmbeddingProvider` について同じ問い
（「決定的でない実装がある中で、実装非依存の契約をどう切るか」）を解いており、
**「決定性は契約ではなく宣言」「宣言は省略できない」「測れないものは `it.skip` で名前を残す」**
という3つの型を確立している。本 ADR はこの型をそのまま `LLMProvider` へ持ち込む
——`EmbeddingProvider` と `LLMProvider` は「実装ごとに決定的かどうかが割れる」という同じ
形の非対称を持つため。

---

## 決定

### 決定1: `describeLLMProviderConformance(options)` を新設する

`packages/testkit/src/llm-provider-conformance.ts`。ADR 0095 の `describeEmbeddingProviderConformance`
と同じ形（`describe` を1つ生やす関数）。

**射程は `packages/core/src/interfaces/llm-provider.ts` の doc コメントが「契約:」として
逐語で書いている条項だけ**——新しい契約は発明しない:

> - `completeStructured` はベンダー固有の Structured Output 機構へ翻訳する義務を negate
>   できない。core・呼び出し側に OpenAI/Anthropic SDK の型を漏らしてはならない。
> - タイムアウト・レート制限・失敗時は例外を投げる。`LLMProvider` 自体はリトライを
>   内蔵しない（責務の混在を避ける）。

**⛔ 特に次は射程外**（ADR 0198 が意図的に外へ出した論点であり、この suite でも触らない。
負債として名指しする）:

- `refusal` / `truncated` / `no_content` を `packages/core` の型へ格上げするかどうか。
- `complete()` が空応答に `?? ""` で空文字を返すことの是非（ADR 0072 負債2）。

**歯（8本、無条件に走るもの4本 + 条件付き4本）**:

| # | 何を固定するか | 条件 |
|---|---|---|
| 1 | `complete` の `Object.keys()` がちょうど `["content"]`、`content` は `string` | 無条件 |
| 2 | `completeStructured` が返すオブジェクトの欄が `structured.schema` の宣言に収まる | 無条件 |
| 3 | `complete` を同じ入力で2回呼ぶと同じ `content` | `deterministic: true` |
| 4 | `completeStructured` を同じ入力で2回呼ぶと同じ値 | `deterministic: true` |
| 5 | `complete`: 下層の失敗を同一の例外オブジェクトのまま伝播する（`rejects.toBe`） | `createFailing !== null` |
| 6 | `complete`: 下層はちょうど1回しか呼ばれない（リトライ非内蔵） | `createFailing !== null` |
| 7 | `completeStructured`: 5 と同じ | `createFailing !== null` |
| 8 | `completeStructured`: 6 と同じ | `createFailing !== null` |

### 決定2: 🔴 `deterministic` と `createFailing` は省略できない宣言にする

**理由は ADR 0095 決定2 と同じ**——「決定的でない」と「宣言し忘れた」を同じ `undefined` に
潰さない。`createFailing` も同じ形にした:

- `deterministic: false` のとき、歯3・4 は消えず `it.skip` として名前だけ残る。
- `createFailing: null` のとき、歯5〜8 は消えず `it.skip` として名前だけ残る。

**⚠ ただし `deterministic` は `LLMProvider` interface の契約ではない**——interface の doc は
決定性について何も約束していない。ADR 0095 の `EmbeddingProvider` 側とはこの点で位置づけが
違う（あちらは順序検査の前提として契約に近い）。この非対称を `llm-provider-conformance.ts`
の doc コメントに明記した。

### 決定3: `texts`/`prompt` と同じ理由で `prompt`/`structured` を呼び出し側に注入させる

`RecordedLLMProvider`（ADR 0051）は記録に無い入力で例外を投げるため、suite が文字列を
決め打ちできない——ADR 0095 決定4 と同じ理由・同じ形。

### 決定4: 足場（呼び出し側のテスト）に、わざとベンダー固有の余計な欄を載せる

**これが設計の芯である。**`packages/anthropic/src/__tests__/llm-provider.conformance.test.ts` と
`packages/openai/src/__tests__/llm-provider.conformance.test.ts` の偽 client は:

- SDK の応答オブジェクトに `id` / `usage` / `model` / `stop_reason`（Anthropic）
  / `created`（OpenAI）などの、実際の SDK が返す欄を実際に持たせる。
- `completeStructured` の偽応答の JSON 本文にも、schema に無い `vendorNote` のようなキーを
  実際に持たせる。

**理由**: もし実装が将来「SDK の応答をそのまま返す」「`schema.parse` をやめて素のキャストに
する」ように壊れても、**偽 client の応答が最初から `content` だけしか持っていなければ、
歯1・歯2はその壊れを検出できずに緑のまま空回りする。**
`packages/openai/src/__tests__/embedding-provider.conformance.test.ts` が
「`data` を逆順で返す」ことで並べ替えロジックへの依存を作っているのと同じ発想を、
「余計な欄を混入させる」という形で `LLMProvider` 側へ適用した。

**さらに、この空回りを検出できることそのものを歯にした**（「適合テストの前提: 足場が歯を
空回りさせていない」describe ブロック）——偽 client の応答・偽応答の JSON が実際に
余計な欄を持つことを、適合 suite を呼ぶ前に固定する。これも ADR 0095 の
「記録した3本のベクトルは互いに異なる」前提テストと同じ形。

### 決定5: ⛔ `RecordedLLMProvider` には当てない

カセットの fixture を組み立てる作業が要り、射程が Issue #389 の外まで膨らむ
（`describeEmbeddingProviderConformance` を `RecordedEmbeddingProvider` へ当てたときの
ADR 0095 決定6と同じ判断の適用だが、あちらは「別の作業へ分ける」、こちらは「この PR の
負債として持ち越す」という違いがある——ADR 0095 は最終的に同じ PR 内の別ファイルで
`RecordedEmbeddingProvider` に当てているが、本 PR はそれを行っていない）。

---

## 採らなかった案

### 案A: `refusal` / `truncated` / `no_content` を core の型へ格上げし、契約として測る

**却下。**ADR 0198 が「採らなかった案」ではなく「この ADR の射程外」として名指しした設計
判断そのものであり、**Issue #389 の本文が挙げる3つの未決の1つ**。この ADR はそこへ踏み込まない
——`docs/autonomy.md` §2「1つの PR は1つの ADR とその実装」に従う。

### 案B: `complete()` の `?? ""` 空文字フォールバックを、この PR で直す

**却下。**両 provider 同時の公開 API の破壊的変更であり、Issue #389 が名指しする設計判断
そのもの（ADR 0198 が同じ理由で却下した「案C」と同じ）。射程の外。

### 案C: 実 API（本物の Anthropic / OpenAI）に当てる

**却下。**`AGENTS.md` の4層表の通り、CI に API キーは無い。`deterministic: true` は
偽 client の固定応答が決定的であることの反映であって、実 API が決定的であることの証明では
ない——この非対称を両テストファイルの doc コメントに明記した。
`packages/openai/src/__tests__/live.openai.test.ts` のような opt-in の実 API テストを
このタイミングで新設することもしていない（Issue #389 の本体は「適合 suite の新設」であり、
実 API テストの拡充は別の話題）。

### 案D: 既存の `call-failure.test.ts` / `provider-parity.test.ts` を、この suite に完全に統合し、
重複するテストを削除する

**却下。**`call-failure.test.ts` はこの suite の歯5〜8と主張が重複するが、**削除しなかった**
——ADR 0198 の「これが覆るとしたら」節に「Issue #389 の適合 suite ができたとき、この4本×2
ファイルは引っ越しの対象になる。**そのとき歯を減らさないこと——suite に同じ主張が在ることを
確かめてから消す**」とある。**この PR では「確かめてから消す」の判断（既存75本超のテストが
実際に何を保証しているかの全数調査）まで手を広げず、共存させたまま新設のみを行った。**
引き受けた負債として残す。

### 案E: `deterministic` / `createFailing` を任意（`?`）にする

**却下。**ADR 0095 決定2 と同じ理由——「宣言し忘れ」と「意図的な `false`/`null`」が
`undefined` に潰れる。

---

## 引き受けた負債

1. 🔴 **`RecordedLLMProvider` に当てていない**（決定5）。⟹ 実質4つある `LLMProvider` の
   実装のうち、この PR が適合 suite で検査したのは `AnthropicLLMProvider` /
   `OpenAILLMProvider` / `DeterministicLLMProvider` の3つで、`RecordedLLMProvider` は
   まだ検査されていない。
2. **HTTP・認証・レート制限・実 API 自身の振る舞いは測っていない。**注入した client は
   手書きの偽物であり、本物の SDK ではない（両テストファイルの冒頭コメントに明記）。
3. **`complete()` の `?? ""` 空文字フォールバックの是非は射程外のまま**（ADR 0198・
   ADR 0072 負債2）。この suite は「空応答が例外にならないこと」自体を歯にしていない
   ——`structured` 側は `no_content` を投げる契約を歯5・7で間接的に固定しているが、
   `complete` 側の空文字フォールバックについては固定していない。
4. **既存の `call-failure.test.ts`（anthropic/openai 各1本）と主張が重複している**
   （歯5〜8とほぼ同じ主張）。**消さなかった理由**は上の「採らなかった案D」の通り
   ——「suite に同じ主張が在ることを確かめてから消す」という ADR 0198 の指示を、
   この PR ではまだ実行していない。⟹ 次に取る一手として残る。
5. **`DeterministicLLMProvider` に対する決定性の歯（3・4）はトリビアルに緑になる。**
   `DeterministicLLMProvider.complete` は入力の最後の user 発話をそのまま返す純関数であり、
   `completeStructured` も入力から機械的に組み立てる純関数——非決定的になりようがない
   構造なので、この歯が「決定性を検査できている」という主張は弱い。同じ注記は
   `packages/testkit/src/__tests__/llm-provider-conformance.test.ts` のコメントに書いていない
   （ADR 側にのみ記録する）。
6. **`createFailing` が測っているのは wrapper 自身であって、production の経路ではない。**
   `client` を注入しているため、`new Anthropic({ apiKey })` / `new OpenAI({ apiKey })` が
   既定で持つ SDK 内部のリトライはこの suite を通らない（ADR 0198 の負債 (a) と同じ）。

7. ⚠ **歯2 は、返り値が1欄も持たないとき空振りで緑になる。**「schema が宣言した欄の集合に
   収まっている」を `Object.keys(result)` の走査として書いているため、`result` が `{}` なら
   ループの中身が一度も走らない。⟹ **「余計な欄が漏れていない」は測るが、「必要な欄が
   落ちていない」は測っていない。**いま実際に欄が落ちないのは `schema.parse()` が欠落で
   投げるからであって、**この歯がそれを見ているからではない。**⟹ M2（`schema.parse` を
   素のキャストへ置き換える変異）は `vendorNote` の漏れとして捕まったが、**欄が落ちるだけの
   変異をこの歯が捕まえるかは測っていない。**

---

## これが覆るとしたら、何が起きたとき

- **`RecordedLLMProvider` 用のカセット fixture を用意したとき。**負債1 を返す一手が
  そのまま次に取れる（`packages/testkit/src/__tests__/llm-provider-conformance.test.ts` に
  `RecordedLLMProvider` 向けの呼び出しを1本足すだけで済む形にしてある）。
- **`refusal`/`truncated`/`no_content` を core の契約へ格上げする判断が下ったとき**
  （案A）。⟹ 歯を増やすことになる。
- **`complete()` の空文字フォールバックを直す判断が下ったとき**（案B）。⟹ 両 provider
  同時の破壊的変更になるはずで、そのときこの suite の歯1（`content` は `string`）は
  「空文字であってはならない」まで強められるかもしれない。
- **既存の `call-failure.test.ts` の主張を suite 側へ完全に統合すると決めたとき**（負債4）。
  ⟹ 重複を消す作業がそのまま次の一手になる。

---

## 測ったこと（変異試験、すべて【実測】2026-09-23）

**全て `cp` で退避 → 変異 → 狙った歯が赤くなることを実測 → `cp` で戻す → 同じ歯が緑に戻る
ことを実測、という手順**（`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」）。
各回、変異を戻した直後に `git status --porcelain` で該当ファイルの差分が消えたことを確認した。

無変異のベースライン: `AnthropicLLMProvider` 10 tests 緑・`OpenAILLMProvider` 10 tests 緑・
`DeterministicLLMProvider` 4 passed / 4 skipped。

### M1: `packages/anthropic/src/llm-provider.ts` の `complete` の返り値に SDK の生の `id` を混ぜる

```
return { content: firstTextBlock(response.content) ?? "", id: response.id } as LLMResponse;
```

```
pnpm --filter @mnemora/anthropic exec vitest run src/__tests__/llm-provider.conformance.test.ts --reporter=verbose
```

**結果**: 1 failed | 9 passed。落ちたのは歯1
`complete が返すオブジェクトの Object.keys() はちょうど ["content"]（ベンダー固有の欄が漏れていない）`
——`expected [ 'content', 'id' ] to deeply equal [ 'content' ]`。戻すと 10 passed に復帰。

### M2: `packages/anthropic/src/llm-provider.ts` の `completeStructured` の `schema.parse` を
素のキャストに置き換える

```
return parsedJson as T;
```

**結果**: 1 failed | 9 passed。落ちたのは歯2
`completeStructured が返すオブジェクトの欄は、structured.schema が宣言した欄の集合に収まっている（余計な欄が漏れていない）`
——`expected false to be true`（`vendorNote` が `allowed` に無いのに返り値に残っていた）。
戻すと 10 passed に復帰。

### M3: `packages/anthropic/src/llm-provider.ts` の `completeStructured` に、失敗したらもう
1回試すリトライを仕込む

```ts
let response;
try {
  response = await this.client.messages.create(createArgs);
} catch {
  response = await this.client.messages.create(createArgs);
}
```

**結果**: 1 failed | 9 passed。落ちたのは歯8
`completeStructured: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）`
——`expected 2 to be 1`。⚠ 歯7（同一の例外オブジェクトのまま伝播する）は**緑のまま**だった
——2回目の呼び出しも同じ sentinel で reject するため、伝播先の例外は変わらない
（`rejects.toBe(sentinel)` は通り続ける）。これは設計上の想定通り（PR 依頼文の
「歯6（または8）が赤」という書き方と一致する——回数の歯だけが「リトライを検出する」歯である）。
戻すと 10 passed に復帰。

### M4: `packages/anthropic/src/llm-provider.ts` の `complete` の例外を
`throw new Error(String(e))` で包み直す

```ts
try {
  response = await this.client.messages.create({ ... });
} catch (e) {
  throw new Error(String(e));
}
```

**結果**: 2 failed | 8 passed。落ちたのは歯5・歯6
（`complete: 下層の失敗を同一の例外オブジェクトのまま伝播する` /
`complete: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）`）——どちらも
`expected Error: Error: llm-provider-conformance: i… to be Error: llm-provider-conformance: injected…`
（同一性 `toBe` が、包み直された別オブジェクトを検出した）。戻すと 10 passed に復帰。

### openai 側: M1 相当（`complete` の返り値に SDK の生の `id` を混ぜる）

```
return { content: response.choices[0]?.message?.content ?? "", id: response.id } as LLMResponse;
```

```
pnpm --filter @mnemora/openai exec vitest run src/__tests__/llm-provider.conformance.test.ts --reporter=verbose
```

**結果**: 1 failed | 9 passed。落ちたのは歯1（同名）——
`expected [ 'content', 'id' ] to deeply equal [ 'content' ]`。戻すと 10 passed に復帰。

### openai 側: M3 相当（`complete` にリトライを仕込む）

```ts
let response;
try {
  response = await this.client.chat.completions.create(createArgs);
} catch {
  response = await this.client.chat.completions.create(createArgs);
}
```

**結果**: 1 failed | 9 passed。落ちたのは歯6
`complete: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）`——`expected 2 to be 1`。
戻すと 10 passed に復帰。

### `createFailing: null` が歯を消さずに `it.skip` として名前を残すことの実測

`packages/testkit/src/__tests__/llm-provider-conformance.test.ts`（`DeterministicLLMProvider`、
`createFailing: null`）を `--reporter=verbose` で走らせると、次の4本が `↓`（skip）として
テスト名つきで出力に残ることを確認した:

```
↓ … > （測っていない: createFailing が null）complete: 下層の失敗を同一の例外オブジェクトのまま伝播する
↓ … > （測っていない: createFailing が null）complete: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）
↓ … > （測っていない: createFailing が null）completeStructured: 下層の失敗を同一の例外オブジェクトのまま伝播する
↓ … > （測っていない: createFailing が null）completeStructured: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）
```

`Tests 4 passed | 4 skipped (8)`。

### 公開 API 表面の門

`pnpm run build` → `node scripts/check-public-api-surface.mjs` の差分は
`@mnemora/testkit` の1ファイルのみで、足した export（`llm-provider-conformance.js` の
再エクスポートと、そこで宣言した2つの interface・1つの関数）だけだった
（他の5パッケージは「差分なし」）。`--write` 後、`git diff scripts/__snapshots__/public-api/`
を確認し、**削除行が1行も無い**（追加23行のみ）ことを確認した。

### 全体の門

- `pnpm run typecheck`（`tsc -p` を対象パッケージごとに実行、および全体）: 緑。
- `pnpm run lint`（`eslint .`）: 緑（差分なし出力）。
- `pnpm run format:check`: 初回は3ファイルが未整形（新設した3ファイル）で赤。
  `pnpm run format` を実行後、`format:check` は緑。
- `pnpm run build`: 全7パッケージ（testkit を含む）が成功。
- 触ったテストのみ絞って実行: `@mnemora/testkit`（`llm-provider-conformance.test.ts`:
  4 passed / 4 skipped）・`@mnemora/anthropic`（`llm-provider.conformance.test.ts`: 10 passed）・
  `@mnemora/openai`（`llm-provider.conformance.test.ts`: 10 passed）。

---

## 確かめていないこと

- **`RecordedLLMProvider` に当てていない**（負債1）。緑になるかどうかは分からない。
- **実 API（本物の Anthropic / OpenAI）が決定的かどうかは測っていない**——`deterministic: true`
  は偽 client の固定応答を反映しているだけである（両テストファイルの doc コメントに明記）。
- **`new Anthropic()` / `new OpenAI()` の既定リトライ回数は測っていない**（負債6、
  ADR 0198 の負債 (a) の継承）。
- **`call-failure.test.ts` / `provider-parity.test.ts` を含む既存75本超が実際に何を保証して
  いるかの全数調査はしていない**（負債4。ADR 0198 が同じ限定を書いている）。
- **`examples/chat` や `runtime.observe()` 側が、この suite が固定した契約にどう依存している
  かは測っていない**（ADR 0198 が同じ限定を書いている）。
- **`structured.schema` が `z.object(...)` 以外（`z.union` 等）のときにどう振る舞うべきかは
  設計していない**——現状は分かりやすい例外を投げて止まる、という選択のみ。

## 参照

- [Issue #389](https://github.com/takecchi/mnemora/issues/389) — この ADR が塞ぐ issue
- [ADR 0072](./0072-anthropic-llm-provider.md) — 負債1（適合 suite の欠落）・負債2（`?? ""`）の出所
- [ADR 0095](./0095-embedding-provider-conformance.md) — `EmbeddingProvider` 側の suite。設計の型の出所
- [ADR 0198](./0198-llm-provider-call-failure-tooth.md) — Issue #389 の一部を先に測った ADR。
  「案A」として suite の新設を採らなかった記録・既存4本×2ファイルとの引っ越しの指示の出所
- [docs/conformance.md](../conformance.md) — 適合テストが何を検証し、何を検証していないか

---

## 追記（2026-09-24）: 負債7 —— 公開 suite は締めず、リポ内の2本にだけ「欄が落ちていない」の歯を足した

⛔ **本節より上は書き換えていない**（`docs/decisions/README.md`）。**負債7 は返済していない。**
公開 suite（`describeLLMProviderConformance`）の歯2 は、いまも `{}` に対して空振りで緑になる。

⚠ **これはクローン（miku）の判断であり、オーナー本人の決定ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

### 何をしたか

- `packages/anthropic/src/__tests__/llm-provider.conformance.test.ts` と
  `packages/openai/src/__tests__/llm-provider.conformance.test.ts` に、describe
  「リポ内の歯（ADR 0266 負債7）: completeStructured は schema が宣言した欄を落とさない」を足した。
  - 前提の歯: 偽応答の JSON が、`structuredSchema` が宣言した欄をすべて持つこと（持たなければ本体の歯が空振りする）。
  - 本体の歯: `completeStructured` の返り値が、宣言された欄をすべて、偽応答と同じ値で持つこと。
- **`packages/testkit/src/llm-provider-conformance.ts` は触っていない。**

### なぜ公開 suite を締めなかったか

`@mnemora/testkit` は公開される（`package.json` に `"private"` が無い）。歯2 は
`packages/testkit/src/index.ts` の `export * from "./llm-provider-conformance.js";` で外へ出ている。
⟹ **公開 suite の歯を締めると、自作 `LLMProvider` のテストからこの suite を呼んでいる利用者が、更新しただけで赤になりうる。**

`docs/migration-v1.md` は、公開の適合 suite の変更を破壊的変更に数えている
（6・13・15。`describeTenantSettingsStoreConformance` / `describeMemoryStoreConformance`）。
⚠ **ただし、この前例はいずれも「必須オプションの追加」であって、「歯を締めた」ものではない。**
歯を締めた前例は【現物】見当たらない。**害の形（利用者の緑が更新だけで赤になる）が同じなので、
破壊的とみなして保留した。**この保留は v2.0.0 の判断（オーナー）の側に置く。

### 測ったこと（【実測】2026-09-24。`cp` で退避 → 変異 → 実行 → `cp` で戻す。戻した直後に `git status --porcelain` で差分が消えたことを確かめた）

ベースライン: 両ファイルとも 12 passed（元の 10 本 + 足した 2 本）。

| 変異（`completeStructured` の `return` 行）                                                 | anthropic            | openai               | 落ちた歯                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| M5: `return {} as T;`（欄が全部落ちる）                                                     | 1 failed / 11 passed | 1 failed / 11 passed | **足した本体の歯だけ。公開 suite の歯2 は緑のまま**——負債7 の空振りを実測で確かめた                                                                 |
| M6: `digest` だけ落として返す（任意欄の欠落）                                               | 1 failed / 11 passed | 1 failed / 11 passed | 足した本体の歯                                                                                                                                      |
| M7（やりすぎ）: `schema.parse` をやめ、素のキャストで返す（余計な欄 `vendorNote` まで返す） | 1 failed / 11 passed | 1 failed / 11 passed | **公開 suite の歯2 だけ。**足した歯は緑——足した歯は「在るべき欄が在る」だけを見ており、「余計な欄が無い」は歯2 に任せている（役割が重なっていない） |
| 足場の変異: 偽応答の JSON から `digest` を消す（anthropic のみ）                            | 2 failed / 10 passed | —                    | 前提の歯と本体の歯                                                                                                                                  |

コマンド: `pnpm --filter @mnemora/<pkg> exec vitest run src/__tests__/llm-provider.conformance.test.ts`

### まだ残っていること

- **公開 suite の歯2 の空振り**（負債7 そのもの）。締めるなら v2.0.0 に載せる破壊的変更として扱う。
- **足した歯は、この repo の2実装だけを見る。**`DeterministicLLMProvider` と `RecordedLLMProvider`
  には当てていない。利用者の自作実装にはもちろん届かない。
