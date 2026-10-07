// プレースホルダ実装（__fixtures__）は意図的にここから export しない。export すると、adapter 作者が
// 自分の実装ではなく Fake に適合テストを走らせて緑にしてしまう。

export * from "./memory-store-conformance.js";
export * from "./relation-store-conformance.js";
export * from "./vector-store-conformance.js";
export * from "./embedding-provider-conformance.js";
export * from "./llm-provider-conformance.js";
export * from "./lexical-store-conformance.js";
export * from "./event-store-conformance.js";
export * from "./outbox-store-conformance.js";
export * from "./tenant-settings-store-conformance.js";
export * from "./test-data.js";

// 次の擬似 provider は adapter パッケージの実 DB 往復テストから再利用されるので、例外的に export する。
export * from "./__fixtures__/deterministic-llm-provider.js";
export * from "./__fixtures__/deterministic-embedding-provider.js";

// 記録した実 API の応答を再生する provider と、録るデコレータ。上の擬似 provider とは用途が違う
// （あちらは配線・契約の stub、こちらは実キー無しで retrieval を測るための記録。ADR 0051）。
export * from "./__fixtures__/cassette.js";
export * from "./__fixtures__/recorded-llm-provider.js";
export * from "./__fixtures__/recorded-embedding-provider.js";
export * from "./__fixtures__/cassette-recorder.js";

// 種カセットから再生し、種に無い入力だけ実 API へ流す provider（記録に無い入力を例外にしない点が `Recorded*` と逆）。
export * from "./__fixtures__/seeded-provider.js";
