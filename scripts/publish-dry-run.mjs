/**
 * ⛔ fail-open にしない。「危険と明示されたときだけ本番」とし、想定外の `dry_run` の値（空文字・未定義・`"TRUE"` 等）は
 * 黙って本番へ倒さず、予行（安全側）にして `warnings` に積む（呼び出し側が `::warning::` を出す）。
 * `release` では `dry_run` を無視する。
 *
 * @param {{ eventName: string, dryRunInput: string | undefined }} params
 * @returns {{ dryRun: boolean, warnings: string[] }}
 */
export function decideDryRun({ eventName, dryRunInput }) {
  if (eventName === "release") {
    // Release の publish を予行にしてはならない。dry_run は release では意味を持たないので無視する。
    return { dryRun: false, warnings: [] };
  }

  if (eventName === "workflow_dispatch") {
    if (dryRunInput === "true") {
      return { dryRun: true, warnings: [] };
    }
    if (dryRunInput === "false") {
      return { dryRun: false, warnings: [] };
    }
    return {
      dryRun: true,
      warnings: [
        `workflow_dispatch の dry_run が "true"/"false" のどちらでもない値でした` +
          `（${JSON.stringify(dryRunInput)}）。安全側の予行（--dry-run）として扱います。`,
      ],
    };
  }

  // 来ないはずの契機で黙って本番へ倒れるのが一番まずいので、安全側へ倒す。
  return {
    dryRun: true,
    warnings: [
      `想定外の event_name でした（${JSON.stringify(eventName)}）。` +
        `安全側の予行（--dry-run）として扱います。`,
    ],
  };
}
