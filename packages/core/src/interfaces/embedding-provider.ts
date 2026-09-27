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
 *
 * ⚠ **2026-09-27 追記（ADR 0305 の追記）: 返ったベクトルが渡した件数より少ない（空を含む）
 * ときの `packages/core` 側の扱い。**`Runtime.tick` の embed ジョブは、`embed` が1件も
 * ベクトルを返さなければ、そのジョブを失敗にし、Memory の `embeddingStatus` を `'failed'`
 * にする——**ベクトルを書かないまま `'ready'` にしない。**embed ジョブは `embed` に常に
 * 1件だけ渡すので、「渡した件数より少ない」はこのジョブでは「空」と同じである
 * （`runtime.ts` の `processEmbedJob`。歯は `packages/core/src/__tests__/embed-job-missing-vector.test.ts`）。
 *
 * ⚠ **2026-09-27 追記（[Issue #1070](https://github.com/takecchi/mnemora/issues/1070)）: 返ったベクトルが
 * 壊れているとき（長さが `space.dimensions` と違う・空・`NaN`/`Infinity` を含む）、
 * `packages/core` は embed ジョブで中身を確かめない。**そのまま {@link VectorStore.upsert} に
 * 渡すので、結果は store の adapter で決まる——`@mnemora/postgres` ではジョブが失敗して
 * `embeddingStatus: 'failed'`、`@mnemora/testkit` の `InMemoryVectorStore` では `'ready'` のまま
 * 保存される（書き分けは `VectorStore.upsert` の doc）。有限性を自分で確かめるのは
 * `@mnemora/local-embedding` だけである（Issue #992）。クエリの埋め込みの側は、
 * 長さ違い・有限でない値とも `recall()` が比較不能として扱う（`RecallQuery.vector` の doc）。
 *
 * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)）:
 * runtime はこの呼び出しに時間の上限を付けず、中断の口（`AbortSignal` など）も渡さない。**`embed` が
 * 返るまで、呼んだ Runtime の口（`observe`・`recall`・`tick`・`consolidate`・`reflect`・`reextract`）も返らない。
 * 上限になるのは provider の側の設定だけである（`@mnemora/openai`・`@mnemora/anthropic` は SDK の既定——
 * 上の #884 の追記、`@mnemora/local-embedding` は推論のタイムアウトを持たない）。待っている間、
 * runtime は DB の接続を握らない（【実測 2026-09-27】`@mnemora/postgres` で `max: 1` の pool の横から
 * 別の DB 操作が通った。歯は `packages/postgres/src/__tests__/provider-hang.postgres.test.ts`）。
 */
export interface EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  embed(ctx: Ctx, texts: string[]): Promise<number[][]>;
}
