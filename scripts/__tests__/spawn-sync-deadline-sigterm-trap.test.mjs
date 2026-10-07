import { describe, expect, it } from "vitest";
import {
  execFileSyncWithDeadline,
  execSyncWithDeadline,
  isDeadlineError,
  spawnSyncWithDeadline,
} from "./spawn-with-deadline.mjs";

/**
 * 期限の kill は SIGKILL である。SIGTERM を無視する子でも、期限のすぐ後に止まり、「期限を超えた」と投げる。
 * SIGTERM で止める実装だと、子が自分で終わる（ここでは8秒後）まで返らない。
 */

const TRAP = 'trap "" TERM; sleep 8';
const BOUND_MS = 5_000;

function elapsedOf(fn) {
  const start = Date.now();
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  return { ms: Date.now() - start, error };
}

describe("期限の kill は SIGTERM を無視する子も止める", () => {
  it.each([
    [
      "spawnSyncWithDeadline",
      () => spawnSyncWithDeadline("bash", ["-c", TRAP], { timeoutMs: 500 }),
    ],
    [
      "execFileSyncWithDeadline",
      () => execFileSyncWithDeadline("bash", ["-c", TRAP], { timeoutMs: 500 }),
    ],
    ["execSyncWithDeadline", () => execSyncWithDeadline(`bash -c '${TRAP}'`, { timeoutMs: 500 })],
  ])("%s", (_label, run) => {
    const { ms, error } = elapsedOf(run);
    expect(isDeadlineError(error)).toBe(true);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
