import type { Ctx, Runtime } from "@mnemora/core";

// ---------------------------------------------------------------------------
// outbox を干上がるまで処理する(PR 本文「実行時の規律」)
//
// 元は `retrieval-quality.ts` の中だけに閉じていたが、`mnemora-path.ts` の
// `ingestConversation`(主測定である `compare` 経路が使う)にも同じ罠が
// あったため、共有モジュールへ切り出した(docs/decisions/0021 参照)。
// ---------------------------------------------------------------------------

export interface DrainResult {
  /** 呼んだ tick() の回数。 */
  ticks: number;
  totalProcessed: number;
  totalFailed: number;
  /** 1回目の tick() が処理した件数(既定 limit=50 が実際に効いた件数)。 */
  firstTickProcessed: number;
}

/**
 * `tick({kinds:['embed']})` を `processed === 0` になるまで繰り返す。
 *
 * **背景(docs/decisions/0019-real-openai-measurement-cost.md §5、
 * docs/decisions/0021-drain-embed-ticks-in-ingest.md)**: `tick()` の既定 `limit` は
 * 50(`DEFAULT_TICK_LIMIT`、`packages/core/src/runtime.ts`)であり、embed ジョブは
 * `claimBatch` が `ORDER BY available_at ASC` で先着順に claim するため、
 * **記憶が50件を超える量を一度に ingest すると、51件目以降は埋め込まれないまま
 * `pending` に残り、`recall()` の ANN 候補にすらならない**(`omitted` には
 * `not_indexed(reason: "pending")` として現れる——`recall()` はこれを隠さず正直に
 * 出す。ADR 0008)。1回の `tick()` では「まだ残っているかもしれない」ことしか
 * 分からないため、`processed === 0`(=もう claim できるジョブが無い)になるまで
 * 呼び続けて初めて「干上がった」と言える。
 *
 * `examples/chat/src/mnemora-path.ts` の `ingestConversation`(`compare` が使う
 * 主測定の取り込み段)と `examples/chat/src/retrieval-quality.ts` の
 * `runRetrievalQualityArm` の両方がこれを使う——どちらも「まとまった量を一度に
 * ingest してから測る」バッチ的な呼び出し側であり、干上がるまで回す責任は
 * `packages/core`(単発の安全弁である `DEFAULT_TICK_LIMIT` を持つ側)ではなく、
 * こちら側にある(ADR 0021「採らなかった案」参照)。
 */
export async function drainEmbedTicks(runtime: Runtime, ctx: Ctx): Promise<DrainResult> {
  let ticks = 0;
  let totalProcessed = 0;
  let totalFailed = 0;
  let firstTickProcessed = 0;
  for (;;) {
    const result = await runtime.tick(ctx, { kinds: ["embed"] });
    ticks += 1;
    totalProcessed += result.processed;
    totalFailed += result.failed;
    if (ticks === 1) {
      firstTickProcessed = result.processed;
    }
    if (result.processed === 0) {
      break;
    }
  }
  return { ticks, totalProcessed, totalFailed, firstTickProcessed };
}
