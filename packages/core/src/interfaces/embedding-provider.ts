import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";

/**
 * EmbeddingProvider — Phase 1（docs/architecture.md §5.5）。
 *
 * 契約:
 * - 1つのインスタンスは1つの `EmbeddingSpaceId` に固定される。次元をモデルに応じて
 *   動的に変える実装は許容しない。
 * - `packages/anthropic` はこの interface を実装しない（Anthropic は埋め込み API を
 *   提供していないため）。
 * - **`texts` の要素が実装の入力上限（トークン数）を超えたら、`embed` は例外を投げる。
 *   黙って切り詰めて、正常な顔をしたベクトルを返してはならない**（ADR 0305、
 *   Issue #449）。上限に当たったこと自体が分からないと、切られたベクトルと
 *   切られていないベクトルが呼び手から同じ顔で返る。上限の値・境界（`>` か `>=`
 *   か）・例外の型は実装ごとに決めてよい——ここが要求するのは
 *   「黙って切って返さないこと」だけである。`@mnemora/local-embedding` は
 *   `kind: "input_too_long"` の例外で満たす（ADR 0090）。`@mnemora/openai` は
 *   専用の検査を持たず、OpenAI のサーバが上限超過を拒否することに依存している——
 *   その依存自体は本 interface の契約ではなく、`@mnemora/openai` 側の負債として
 *   ADR 0305 に記録してある。
 *
 * ⚠ **2026-09-26 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)）:
 * `embed` は `texts` と同じ件数・同じ順序でベクトルを返す。この一致自体は本
 * interface の契約だが、守り方は実装ごとに違う。**`@mnemora/local-embedding` は
 * 返ってきたベクトルの件数・次元を実行時に `texts`/`space.dimensions` と突き合わせ、
 * 食い違えば例外を投げる（`packages/local-embedding/src/local-embedding-provider.ts`）。
 * `@mnemora/openai` の `OpenAIEmbeddingProvider.embed` はこの突き合わせを持たず、
 * `response.data` を `index` で並べ替えて返すだけで、件数・次元が `texts`/`space` と
 * 一致することは OpenAI の応答に依存している——上の入力上限の項と同じ形で、
 * 「サーバが正しい件数・次元を返すこと」に依存する側の負債として ADR 0305 に記録して
 * ある。応答の件数が `texts` と食い違った場合の `OpenAIEmbeddingProvider` の結果は
 * 未定義である。`packages/core` の本番経路（`runtime.ts`/`recall-runtime.ts`）は
 * どちらも `embed` に常に1件ずつ渡すため、この食い違いは踏まれていない。
 */
export interface EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  embed(ctx: Ctx, texts: string[]): Promise<number[][]>;
}
