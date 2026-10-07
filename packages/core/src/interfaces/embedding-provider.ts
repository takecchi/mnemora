import type { AbortOptions } from "../abort.js";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";

/**
 * EmbeddingProvider（docs/architecture.md §5.5）。
 *
 * 契約:
 * - 1つのインスタンスは1つの `EmbeddingSpaceId` に固定される。次元を動的に変える実装は許容しない。
 * - **`texts` の要素が実装の入力上限（トークン数）を超えたら、`embed` は例外を投げる。
 *   黙って切り詰めて、正常な顔をしたベクトルを返してはならない**（ADR 0305）。
 *   上限の値・境界・例外の型は実装ごとに決めてよい。`@mnemora/local-embedding` は
 *   `kind: "input_too_long"` の例外で満たす（ADR 0090）。`@mnemora/openai` は専用の検査を持たず、
 *   OpenAI のサーバが拒否することに依存している。
 * - **`embed` は `texts` と同じ件数・同じ順序でベクトルを返し、各ベクトルの長さは `space.dimensions` と等しく、
 *   成分はすべて有限である**（ADR 0393）。`@mnemora/openai`・`@mnemora/local-embedding` は実行時に検査し、
 *   崩れていれば例外を投げる（`@mnemora/openai` は `OpenAIEmbeddingProvider:` で始まる素の `Error`）。
 *
 * `packages/core` の扱い:
 * - embed ジョブは `embed` が1件もベクトルを返さなければジョブを失敗にし、`embeddingStatus` を `'failed'` にする（ADR 0305）。
 * - embed ジョブは `VectorStore.upsert` の前に長さと有限性を確かめ、崩れていればジョブを失敗にして
 *   `embeddingStatus: 'failed'` にする（ADR 0393）。`recall()` は、provider が返した問い合わせベクトルが崩れていれば
 *   `embedding_provider_unavailable` に丸める。**呼び出し側が `RecallQuery.vector` を直接渡した経路は検査しない。**
 * - 中断: `embed` は任意の第3引数 `opts?: AbortOptions` を受け取る。挙動は `LLMProvider.complete`/`completeStructured`
 *   （`llm-provider.ts`）と同じ（ADR 0359）。
 * - `@mnemora/openai` は SDK 呼び出しを core の `runAbortable` で包む。直に呼んだときも abort の reject の値は
 *   `signal.reason` で、SDK の再試行待ちの最中でも abort の時点で返る（ADR 0428、ADR 0445）。
 * - `@mnemora/local-embedding` は、推論の前後と、モデルの読み込み待ち・読み込みの再試行の待ちで `signal` を見る。
 *   件数が `maxBatchSize` を超えて分割されたときは、チャンクの合間でも見る。**動いている1チャンクの推論と、
 *   共有の読み込みそのものは止まらない**。
 */
export interface EmbeddingProvider {
  /** この provider が作るベクトルの埋め込み空間（`provider`・`model`・`dimensions`）。構築時に決まり、変わらない（1インスタンス = 1空間）。 */
  readonly space: EmbeddingSpaceId;
  /** `texts` を埋め込み、同じ件数・同じ順でベクトルを返す。空配列なら `[]`（件数・次元・有限性は実行時に検査する。上の契約）。`opts.signal` は上の「中断」を参照。 */
  embed(ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]>;
}
