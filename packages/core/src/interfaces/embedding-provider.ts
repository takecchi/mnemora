import type { AbortOptions } from "../abort.js";
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
 *   入力上限の専用の検査を持たず、OpenAI のサーバが上限超過を拒否することに依存している
 *   （本 interface の契約ではなく `@mnemora/openai` 側の負債。ADR 0305 に記録）。
 * - **`embed` は `texts` と同じ件数・同じ順序でベクトルを返し、各ベクトルの長さは
 *   `space.dimensions` と等しく、成分はすべて有限である**（[Issue #860](https://github.com/takecchi/mnemora/issues/860)、ADR 0393）。
 *   `@mnemora/openai`・`@mnemora/local-embedding` とも実行時に検査し、崩れていれば例外を投げる
 *   （`@mnemora/openai` は `OpenAIEmbeddingProvider:` で始まる素の `Error`）。
 *
 * `packages/core` の扱い:
 * - embed ジョブ（`runtime.ts` の `processEmbedJob`）は `embed` が1件もベクトルを返さなければ
 *   ジョブを失敗にし、Memory の `embeddingStatus` を `'failed'` にする。ベクトルを書かないまま
 *   `'ready'` にしない（ADR 0305。歯は `__tests__/embed-job-missing-vector.test.ts`）。
 * - embed ジョブは `VectorStore.upsert` の前に長さと有限性を確かめ、崩れていればジョブを失敗にして
 *   `embeddingStatus: 'failed'` にする（ADR 0393）。`recall()` は、provider が返した問い合わせベクトルが
 *   崩れていれば `embedding_provider_unavailable` に丸める（`recall-runtime.ts`）。
 *   **呼び出し側が `RecallQuery.vector` を直接渡した経路は検査しない。**
 * - 中断: `embed` は任意の第3引数 `opts?: AbortOptions` を受け取る（Issue #1200、
 *   [ADR 0359](../../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。挙動は
 *   `LLMProvider.complete`/`completeStructured`（`llm-provider.ts`）と同じ——呼ぶ前に abort 済みなら
 *   呼ばずに reject、呼んでいる間に abort されたら provider が対応していなくても runtime が reject する。
 *   既定の時間の上限は無い。待っている間、runtime は DB の接続を握らない。
 * - `@mnemora/openai` は SDK 呼び出しを core の `runAbortable` で包む。直に呼んだときも、abort の reject の値は
 *   `signal.reason` で、SDK の再試行待ちの最中でも abort の時点で返る
 *   （[ADR 0428](../../../../docs/decisions/0428-provider-abort-reason-and-error-guards.md)、
 *   [ADR 0445](../../../../docs/decisions/0445-local-embedding-chunk-abort-chat-drain-provider-docs.md)）。
 * - `@mnemora/local-embedding` は、推論の前後と、モデルの読み込み待ち・読み込みの再試行の待ちで `signal` を見る。
 *   件数が `maxBatchSize` を超えて分割されたときは、チャンクの合間でも見る。**動いている1チャンクの推論と、
 *   共有の読み込みそのものは止まらない**（transformers.js のパイプライン呼び出しを中断する口が無いため）。
 */
export interface EmbeddingProvider {
  /** この provider が作るベクトルの埋め込み空間（`provider`・`model`・`dimensions`）。構築時に決まり、変わらない（1インスタンス = 1空間）。 */
  readonly space: EmbeddingSpaceId;
  /** `texts` を埋め込み、同じ件数・同じ順でベクトルを返す。空配列なら `[]`（件数・次元・有限性は実行時に検査する。上の契約）。`opts.signal` は上の「中断」を参照。 */
  embed(ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]>;
}
