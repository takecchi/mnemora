# ADR 0615: 09/27 にマージされた provider の PR（#1223・#1147・#1083）の確かめ直しで見つかった穴に歯を足す（読み込み失敗のメッセージが名指す場所・包むときの $defs）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1725](https://github.com/takecchi/mnemora/issues/1725) で、そこに確かめ直しの記録が残っている。testkit・Fake の分（PR [#1730](https://github.com/takecchi/mnemora/pull/1730)）とは別の、小さな試験だけの PR にすると、クローンが決めた。
マネージャー（mgr-78d4264a）が歯を書いた。出所の区別: 【現物】は読んだコード・PR 本文、【実測】は手元で走らせた結果、【判断】はマネージャーの判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）には触れない。

## 経緯

前の担当（mgr-955ee40f）が、provider の3本を、約束ごとに変異を入れて確かめ直した【実測】。どの歯にも捕まらず、約束の内とみたすり抜けが5つあった（#1725）。このうち、実 API の鍵も実モデルのダウンロードも要らない形で歯を書けるものを足す。

## 決定【判断】

1. 実装は変えない。
2. 歯ごとに、今の main で緑になること、狙う変異で赤になること、`cp` で戻して `cmp` で一致させた後に緑になることを実測した。

| 出所の PR | 約束（PR 本文・TSDoc） | 足した歯 | 赤にした変異 |
| --- | --- | --- | --- |
| #1223 | `createPipeline` を注入したときは、場所を断言しない | 先に既定の pipeline を失敗させて記録を作り、その後で注入した provider を失敗させる。後者のメッセージが記録の場所を含まない | 注入したときも記録を使う |
| #1223 | `cacheDir` を渡したときは、その値を名指す | `cacheDir: "/x/"` で失敗させ、`/x/<repo>` を名指し、既定の場所を含まない | 既定の場所を `cacheDir` より優先する |
| #1223 | `env.cacheDir` が null や空なら、断言しない | `env.cacheDir = ""` で、場所を断言しない表記になる | 空文字も記録する |
| #1147 | `$defs` は包みの根に残す（`wrapRootSchema` の TSDoc） | 枝が再帰する共有のスキーマを持つ根の union。送る形の根に `$defs` があり、`result` の内側には無い | `$defs` を包みの内側に置く |

置き場: `packages/local-embedding/src/__tests__/load-failure-cache-place.test.ts`（`@huggingface/transformers` は `vi.mock` で差し替えるので、本物のモデルは読まない）と `packages/openai/src/__tests__/structured-root-union.test.ts`。

## 外したもの

- **#1083 の M8**（anthropic の authToken の検査で `Bearer ` の接頭辞を落とす）: 歯を書いたところ、今の main で赤になった【実測】。SDK（`@anthropic-ai/sdk` 0.124.0）は `ANTHROPIC_AUTH_TOKEN` を `readEnv` で読み、その場で `.trim()` する（`internal/utils/env.js`）【現物】。`AnthropicLLMProvider` が authToken を受け取る道はこの環境変数だけなので、先頭の LF は検査に届く前に消える。接頭辞の有無で結果が変わる入力は、公開の口からは作れない。振る舞いの変わらない変異なので、歯は足さない。
- **#1223 の M6・M10**（Windows の `\` で終わる場所・文字列でない値）と **#1147 の G**（anyOf の守り）: #1725 で、弱い・約束の外とみたもの。足さない。

## これが覆るとしたら

上の表の約束が変わるとき。#1083 については、`AnthropicLLMProvider` が authToken を引数で受け取るようになるか、SDK が環境変数を trim しなくなったとき。そのときは M8 が観測できるようになるので、歯を足す。
