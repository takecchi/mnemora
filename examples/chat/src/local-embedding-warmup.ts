import type { EmbeddingProvider } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";

/**
 * 「重みを取得できなかった」と「測ったが値が悪かった」を区別するための preflight。
 * 重みは最初の `embed()` まで遅延ロードされるので、対策しないと取得失敗が ingest 中の `embed()` で起き、
 * 一部の probe だけ数字が出る壊れ方になる。arm を走らせる前に呼び、`ok: false` なら一件もメトリクスを出さずに打ち切ること。
 *
 * `LocalEmbeddingProvider` でなければ何もせず `ok: true` を返す。重みを取得する概念が無い provider に
 * 「重みを取得できなかった」を出さないため、対象外を `ok: false` の側に混ぜない。
 */
export interface WarmupOutcome {
  ok: boolean;
  detail: string;
}

export const WEIGHTS_UNAVAILABLE_PREFIX = "重みを取得できなかったので、値は測っていない";

export async function warmupLocalEmbedding(provider: EmbeddingProvider): Promise<WarmupOutcome> {
  if (!(provider instanceof LocalEmbeddingProvider)) {
    return {
      ok: true,
      detail:
        "(LocalEmbeddingProvider ではないため warmup 対象外——このモードに重み取得の失敗モードは無い)",
    };
  }
  try {
    await provider.warmup();
    return { ok: true, detail: "モデルの読み込みに成功した(warmup() 完了)" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `cause` を捨てない。捨てると、ネットワーク断・repo 消滅・dtype 名の誤りを区別する材料が消える。
    const cause = error instanceof Error ? error.cause : undefined;
    const causeMessage = cause instanceof Error ? ` cause: ${cause.message}` : "";
    return {
      ok: false,
      detail: `${WEIGHTS_UNAVAILABLE_PREFIX}: ${message}${causeMessage}`,
    };
  }
}
