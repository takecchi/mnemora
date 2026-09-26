// packages/testkit — adapter が満たすべき適合テスト一式（conformance suite）。
// プレースホルダ実装（__fixtures__）は意図的にここから export しない。
// adapter 作者は自分の実装を `createStore` に渡して conformance suite を走らせる。
//
// Issue #809（2026-09-26、クローン miku）: 適合テスト（`*-conformance.ts`）には入力検証の
// 要件を足さないと決めた。理由は、要件を足すと外部 adapter の CI を新しく赤にしうるため。
// __fixtures__ の Fake と Postgres 実装の食い違いは Fake 側を直し、その回帰の歯は
// `src/__tests__/`（このパッケージの内部だけで完結するテスト）に置く——`*-conformance.ts`
// 自体は変更しない。採らなかった案は、適合テストに要件を足して minor で出す
// （CHANGELOG の告知だけで外部実装を赤にする）。

export * from "./memory-store-conformance.js";
export * from "./vector-store-conformance.js";
export * from "./embedding-provider-conformance.js";
export * from "./llm-provider-conformance.js";
export * from "./lexical-store-conformance.js";
export * from "./event-store-conformance.js";
export * from "./outbox-store-conformance.js";
export * from "./tenant-settings-store-conformance.js";
export * from "./test-data.js";

// roadmap.md 段階3: LLM/EmbeddingProvider の決定的な擬似実装。
// PR 本文「擬似物の扱い」の通り、これは本物の provider の代替ではない
// （CI で本物の LLM/埋め込みモデルを叩けないための擬似物であることを隠さない）。
// __fixtures__ の Store 系プレースホルダとは異なり、これらは adapter パッケージ
// （packages/postgres の実 DB 往復テスト等）から再利用されることを意図しており、
// 意図的に index.ts から export する。
export * from "./__fixtures__/deterministic-llm-provider.js";
export * from "./__fixtures__/deterministic-embedding-provider.js";

// ADR 0051: 記録した実 API の応答を再生する provider と、それを録る側のデコレータ。
// 上の決定的な擬似物とは**用途が違う**——あちらは配線・契約・適合テスト用の stub、
// こちらは北極星の物差し（examples/chat の retrieval）を実キー無しで測るための記録である。
// 二層に分けた理由と引き受けた負債は ADR 0051 を見ること。
export * from "./__fixtures__/cassette.js";
export * from "./__fixtures__/recorded-llm-provider.js";
export * from "./__fixtures__/recorded-embedding-provider.js";
export * from "./__fixtures__/cassette-recorder.js";

// Issue #691 続き: 「種カセット」から再生し、種に無い入力だけ実 API へ流す provider。
// `record` サブコマンドが、記憶集合を旧カセットへ揃えるために使う（上の
// `Recorded*`/`Recording*` とは逆方向——記録に無い入力を例外にせず、delegate へ流す）。
export * from "./__fixtures__/seeded-provider.js";
