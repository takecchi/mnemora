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
 *   入力上限については専用の検査を持たず（応答の検査とは別の話。2026-09-30 に応答の検査は足した）、OpenAI のサーバが上限超過を拒否することに依存している——
 *   その依存自体は本 interface の契約ではなく、`@mnemora/openai` 側の負債として
 *   ADR 0305 に記録してある。
 *
 * ⚠ **2026-09-30 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)、ADR 0305 の同日付追記）:
 * 下の 2026-09-26 の追記（「`@mnemora/openai` は検査せず、食い違ったときの結果は未定義」）は、もう成り立たない。**
 * `OpenAIEmbeddingProvider.embed` も、応答の件数が `texts.length` と等しいこと・`index` が 0..n-1 を
 * ちょうど1回ずつであること・各ベクトルの長さが `space.dimensions` と等しいこと・成分がすべて有限であることを
 * 確かめ、崩れていれば素の `Error`（`OpenAIEmbeddingProvider:` で始まる）を投げる。2つの実装
 * （`@mnemora/openai`・`@mnemora/local-embedding`）とも、食い違った応答を黙って返さない。
 * これは新しく例外になる場合が増える変更であり、CHANGELOG `[1.2.0]` に破壊的変更として書いてある。
 *
 * ⚠ **2026-09-26 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)。⚠ `@mnemora/openai` に
 * ついての部分は上の 2026-09-30 の追記で古くなった。当時の記述として残す）:
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
 * ⚠ **2026-09-27 追記（[Issue #1070](https://github.com/takecchi/mnemora/issues/1070)。**長さも有限性も
 * 下の 2026-09-30 追記で覆った**）: 返ったベクトルが
 * 壊れているとき（長さが `space.dimensions` と違う・空・`NaN`/`Infinity` を含む）、
 * `packages/core` は embed ジョブで中身を確かめない。**そのまま `VectorStore.upsert`（`interfaces/vector-store.ts`） に
 * 渡すので、結果は store の adapter で決まる——`@mnemora/postgres` ではジョブが失敗して
 * `embeddingStatus: 'failed'`、`@mnemora/testkit` の `InMemoryVectorStore` では `'ready'` のまま
 * 保存される（書き分けは `VectorStore.upsert` の doc）。有限性を自分で確かめるのは
 * `@mnemora/local-embedding` だけである（Issue #992）。クエリの埋め込みの側は、
 * 長さ違い・有限でない値とも `recall()` が比較不能として扱う（`RecallQuery.vector` の doc）。
 *
 * ⚠ **2026-09-30 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)、ADR 0393）:
 * 返ったベクトルの長さが `space.dimensions` と違うか、成分に
 * `NaN`/`Infinity` を含むとき、`packages/core` は provider を問わずこれを弾く。**embed ジョブ
 * （`runtime.ts` の `processEmbedJob`）は `VectorStore.upsert` の前に確かめ、崩れていればジョブを失敗にして
 * `embeddingStatus: 'failed'` にする（次元違いなら期待した次元と実際の次元、有限でなければ位置と値を
 * メッセージに含む）。`recall()` は、provider が返した問い合わせベクトルが崩れていれば
 * 「ベクトルを返さなかった」と同じく `embedding_provider_unavailable` に丸める
 * （`recall-runtime.ts`。`score_not_comparable` にはならない）。**呼び出し側が `RecallQuery.vector` を直接渡した
 * 経路は検査しない**。歯は `packages/core/src/__tests__/embed-job-dimension-mismatch.test.ts`・
 * `recall-query-embedding-dimension-mismatch.test.ts`・`embed-job-non-finite-vector.test.ts`・
 * `recall-query-embedding-non-finite.test.ts`。
 *
 * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)）:
 * runtime はこの呼び出しに時間の上限を付けず、中断の口（`AbortSignal` など）も渡さない。**`embed` が
 * 返るまで、呼んだ Runtime の口（`observe`・`recall`・`tick`・`consolidate`・`reflect`・`reextract`）も返らない。
 * 上限になるのは provider の側の設定だけである（`@mnemora/openai`・`@mnemora/anthropic` は SDK の既定——
 * 上の #884 の追記、`@mnemora/local-embedding` は推論のタイムアウトを持たない）。待っている間、
 * runtime は DB の接続を握らない（【実測 2026-09-27】`@mnemora/postgres` で `max: 1` の pool の横から
 * 別の DB 操作が通った。歯は `packages/postgres/src/__tests__/provider-hang.postgres.test.ts`）。
 *
 * ⚠ **2026-09-29 追記（クローン miku の判断。[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）: 上の「中断の口も渡さない」は
 * もう成り立たない。** `embed` は任意の第3引数 `opts?: AbortOptions` を受け取る。挙動は
 * `LLMProvider.complete`/`completeStructured`（`llm-provider.ts` 同日付追記）と同じ——
 * 呼ぶ前に既に abort 済みなら呼ばずに reject、呼んでいる間に abort されたら provider が
 * 対応していなくても runtime が reject する、既定の時間の上限は今回も無い。
 * `@mnemora/openai` は SDK 呼び出しへ `{ signal }` を渡す。`@mnemora/local-embedding` は
 * 推論の**前後**で `signal.throwIfAborted()` 相当を確かめるだけであり、**推論の途中では
 * 止まらない**（transformers.js のパイプライン呼び出し自体を中断する口を持たないため）。
 */
export interface EmbeddingProvider {
  /** この provider が作るベクトルの埋め込み空間（`provider`・`model`・`dimensions`）。構築時に決まり、変わらない（1インスタンス = 1空間）。 */
  readonly space: EmbeddingSpaceId;
  /** `texts` を埋め込み、同じ件数・同じ順でベクトルを返す。空配列なら `[]`（件数・次元・有限性は、`@mnemora/openai`・`@mnemora/local-embedding` とも実行時に検査する。上の 2026-09-30 の追記）。`opts.signal` は上の2026-09-29追記を参照。 */
  embed(ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]>;
}
