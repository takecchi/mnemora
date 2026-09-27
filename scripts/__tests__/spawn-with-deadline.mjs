import { execFileSync, spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

/** 子の close を待つ既定の期限（ミリ秒）。歯の `testTimeout`（180 秒）より十分に短くする。 */
export const DEFAULT_CHILD_DEADLINE_MS = 30_000;

/** SIGKILL の後、子の close を待つ上限（ミリ秒）。 */
const KILL_GRACE_MS = 5_000;

/**
 * 同期の子の既定の期限（ミリ秒）。【実測】`pnpm pack` を除くと、1ファイル全体でも CI で最長 7.7 秒
 * （2026-09-27、main の 06a1eac の run）——十分な余裕を持ち、`testTimeout`（180 秒）より短い値にした。
 */
export const DEFAULT_SYNC_CHILD_DEADLINE_MS = 60_000;

/**
 * node のスクリプトを子として起こし、終わるまで待って `{ code, stdout, stderr }` を返す。
 *
 * **子が `timeoutMs` までに close しなければ、子を SIGKILL し、「子が N 秒で close しなかった」と名乗って reject する。**
 * 【実測 2026-09-28】負荷の下で、引数を読んで exit するだけの CLI の子が、node のプロセスごと止まる（全スレッドが
 * futex / epoll で待ったまま exit に至らない）ことがあった。期限を持たずに `close` を待つと、歯は `testTimeout`
 * （180 秒）まで何も言わずに待ち、止まった子は親が死んだ後も残った。原因は子の node の内側にあり、断定していない
 * ——ここでするのは、止まりを「何を何秒待ったか」が分かる失敗に変えることだけである（再試行はしない）。
 *
 * @param {string} script
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, onSpawn?: (child: import("node:child_process").ChildProcess) => void }} [options]
 */
export function runNodeScript(
  script,
  args,
  { env, timeoutMs = DEFAULT_CHILD_DEADLINE_MS, onSpawn } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let timedOut = false;
    const fail = () =>
      reject(
        new Error(
          `子（${basename(script)} ${args.join(" ")}）が ${timeoutMs / 1000} 秒で close しなかった` +
            `（SIGKILL した。pid=${child.pid}）。ここまでの stdout: ${JSON.stringify(stdout.slice(0, 200))}` +
            ` / stderr: ${JSON.stringify(stderr.slice(0, 200))}`,
        ),
      );
    // 期限を超えたら kill し、子が本当に終わった（close した）後で reject する——落ちたときに子を残さない。
    // kill しても close が来ないときのために、もう一段の上限を置く。
    let afterKill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      afterKill = setTimeout(fail, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        clearTimeout(afterKill);
        fail();
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 同期の子が期限を超えたときに投げる例外の文面を作る。
 * @param {string} command @param {readonly string[]} args @param {number} timeoutMs
 * @param {unknown} stdout @param {unknown} stderr
 */
function syncDeadlineError(command, args, timeoutMs, stdout, stderr, cause) {
  const text = (v) => JSON.stringify(String(v ?? "").slice(0, 200));
  return new Error(
    `子（${basename(String(command))} ${args.join(" ")}）が ${timeoutMs / 1000} 秒で終わらなかった` +
      `（SIGKILL した）。ここまでの stdout: ${text(stdout)} / stderr: ${text(stderr)}`,
    { cause },
  );
}

/**
 * `spawnSync` と同じ引数で子を起こし、**期限の内なら `spawnSync` と同じ戻り値をそのまま返す。**
 * 期限（既定 {@link DEFAULT_SYNC_CHILD_DEADLINE_MS}）を超えたら子を SIGKILL し、「子（コマンド 引数）が N 秒で
 * 終わらなかった」と名乗って**投げる**（素の `spawnSync` は、期限を超えても投げずに `error: ETIMEDOUT` を返すだけで、
 * 呼び出し側の歯は `expected null to be 0` のような、止まりと読めない形で落ちる）。
 *
 * ⚠ **同期の呼び出しの間は、vitest の `testTimeout` も効かない。**【実測 2026-09-28】200 ms の timer は、3 秒で
 * 終わる子の `spawnSync` が返るまで発火せず、4062 ms に発火した——同期の呼び出しはイベントループを塞ぐので、
 * timer で実装されている `testTimeout` はその間に割り込めない。⟹ 子が止まると、期限の無い同期の呼び出しは、
 * 子が終わるまで worker ごと何も言わずに止まり続ける。この関数の期限が、その間の唯一の上限である。
 *
 * `killSignal` は SIGKILL にする（SIGTERM を無視する子でも止まるように）。
 *
 * @param {string} command @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions & { timeoutMs?: number }} [options]
 */
export function spawnSyncWithDeadline(command, args, options = {}) {
  const { timeoutMs = DEFAULT_SYNC_CHILD_DEADLINE_MS, ...rest } = options;
  const result = spawnSync(command, args, { ...rest, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (result.error && result.error.code === "ETIMEDOUT") {
    throw syncDeadlineError(command, args, timeoutMs, result.stdout, result.stderr, result.error);
  }
  return result;
}

/**
 * `execFileSync` と同じ引数で子を起こし、**期限の内なら `execFileSync` と同じ戻り値（stdout）を返し、非0の終了では
 * 同じく投げる。** 期限を超えたら子を SIGKILL し、「子（コマンド 引数）が N 秒で終わらなかった」と名乗って投げる
 * （素の `execFileSync` の文面は `spawnSync <path> ETIMEDOUT` で、引数も秒数も出ない）。
 * `testTimeout` が効かないことは {@link spawnSyncWithDeadline} の doc と同じ。
 *
 * @param {string} command @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions & { timeoutMs?: number }} [options]
 */
export function execFileSyncWithDeadline(command, args, options = {}) {
  const { timeoutMs = DEFAULT_SYNC_CHILD_DEADLINE_MS, ...rest } = options;
  try {
    return execFileSync(command, args, { ...rest, timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (error) {
    if (error && error.code === "ETIMEDOUT") {
      throw syncDeadlineError(command, args, timeoutMs, error.stdout, error.stderr, error);
    }
    throw error;
  }
}
