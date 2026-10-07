import type { PostgresClient } from "@mnemora/postgres";

/** `examples/chat` は `pg` を直接の依存に持たない。`PostgresClient["pool"]` を型として借り、phantom dependency を作らずに `Pool` の型を得る。 */
type Pool = PostgresClient["pool"];

/**
 * `consolidation-cost` サブコマンドが、`embeddingStatus: "failed"` に着地した Memory について `LocalEmbeddingProviderError.kind` を読むための薄いヘルパ。
 *
 * `Memory`/`MemoryStore` は `kind` を保存しない。`tick()` は例外を `outbox.last_error` に文字列として残すだけなので、
 * `kind` を知る手段は、その文字列を `packages/local-embedding/src/pipeline.ts` が投げる文言で判別する以外に無い。
 * `packages/core`/`packages/postgres` は変更しない制約の下でこれ以上の精度は買えないため、
 * このヘルパは文字列一致による推定であることを名乗る（`"unknown"` を返す経路を持つ）。
 */

const INPUT_TOO_LONG_MARKER = "上限を超えている";
const UNKNOWN_INPUT_LIMIT_MARKER = "上限を宣言していない";

/** エラーメッセージ文字列から `LocalEmbeddingProviderErrorKind` を推定する純関数。判別できなければ `"unknown"`。 */
export function classifyEmbedFailureMessage(
  message: string,
): "input_too_long" | "unknown_input_limit" | "unknown" {
  if (message.includes(INPUT_TOO_LONG_MARKER)) {
    return "input_too_long";
  }
  if (message.includes(UNKNOWN_INPUT_LIMIT_MARKER)) {
    return "unknown_input_limit";
  }
  return "unknown";
}

/**
 * その `memoryId` に対する `embed` ジョブのうち、最後に失敗したものの `last_error` から `kind` を返す。
 * 失敗したジョブが無ければ `null`。DB を要求するので、`consolidation-cost.postgres.test.ts` 側で検査する。
 */
export async function lookupLatestEmbedFailureKind(
  pool: Pool,
  tenantId: string,
  memoryId: string,
): Promise<"input_too_long" | "unknown_input_limit" | "unknown" | null> {
  const result = await pool.query<{ last_error: string | null }>(
    `SELECT last_error FROM outbox
       WHERE tenant_id = $1 AND kind = 'embed' AND payload->>'memoryId' = $2
         AND failed_at IS NOT NULL AND last_error IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    [tenantId, memoryId],
  );
  const row = result.rows[0];
  if (!row || row.last_error === null) {
    return null;
  }
  return classifyEmbedFailureMessage(row.last_error);
}
