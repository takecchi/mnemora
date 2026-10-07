import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

class ChildDeadlineError extends Error {}

/**
 * @param {unknown} error
 */
export function isDeadlineError(error) {
  return error instanceof ChildDeadlineError;
}

export const DEFAULT_CHILD_DEADLINE_MS = 30_000;

const KILL_GRACE_MS = 5_000;

// 子だけに SIGKILL を送ると孫が残るので、グループごと止める。detached の副作用で、端末の Ctrl-C は子に届かない
// （止めるのは期限の kill）。
/**
 * @param {number | undefined} pid
 * @param {(pid: number, signal: string) => void} [kill] 歯から例外の扱いを確かめるための注入点。既定は `process.kill`。
 */
export function killProcessGroup(pid, kill = process.kill.bind(process)) {
  if (!pid) return;
  try {
    kill(-pid, "SIGKILL");
  } catch (error) {
    if (error && error.code === "ESRCH") return;
    throw error;
  }
}

export const DEFAULT_SYNC_CHILD_DEADLINE_MS = 60_000;

// 期限を持たずに close を待つと、止まった子で歯が testTimeout まで黙って待つ。止まりを「何を何秒待ったか」が
// 分かる失敗に変えるだけで、再試行はしない。
/**
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
      detached: true,
    });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let timedOut = false;
    const fail = () =>
      reject(
        new ChildDeadlineError(
          `子（${basename(script)} ${args.join(" ")}）が ${timeoutMs / 1000} 秒で close しなかった` +
            `（プロセスグループごと SIGKILL した。pid=${child.pid}）。ここまでの stdout: ${JSON.stringify(stdout.slice(0, 200))}` +
            ` / stderr: ${JSON.stringify(stderr.slice(0, 200))}`,
        ),
      );
    // 子が本当に close した後で reject する（落ちたときに子を残さない）。
    let afterKill;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
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
 * @param {string} label 子の名乗り（`コマンド 引数`、`execSync` ならコマンドの文字列そのもの）
 * @param {number} timeoutMs @param {unknown} stdout @param {unknown} stderr
 */
function syncDeadlineError(label, timeoutMs, stdout, stderr, cause) {
  const text = (v) => JSON.stringify(String(v ?? "").slice(0, 200));
  return new ChildDeadlineError(
    `子（${label}）が ${timeoutMs / 1000} 秒で終わらなかった` +
      `（プロセスグループごと SIGKILL した）。ここまでの stdout: ${text(stdout)} / stderr: ${text(stderr)}`,
    { cause },
  );
}

/** @param {string} command @param {readonly string[]} args */
const commandLabel = (command, args) => `${basename(String(command))} ${args.join(" ")}`;

// 素の spawnSync は期限を超えても投げず ETIMEDOUT を返すだけ。同期の呼び出しの間は testTimeout も効かない
// （イベントループを塞ぐ）ので、この期限が唯一の上限になる。killSignal は SIGKILL（SIGTERM を無視する子でも止める）。
/**
 * @param {string} command @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions & { timeoutMs?: number }} [options]
 */
export function spawnSyncWithDeadline(command, args, options = {}) {
  const { timeoutMs = DEFAULT_SYNC_CHILD_DEADLINE_MS, ...rest } = options;
  const result = spawnSync(command, args, {
    ...rest,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: true,
  });
  if (result.error && result.error.code === "ETIMEDOUT") {
    killProcessGroup(result.pid);
    throw syncDeadlineError(
      commandLabel(command, args),
      timeoutMs,
      result.stdout,
      result.stderr,
      result.error,
    );
  }
  return result;
}

/**
 * @param {string} command @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions & { timeoutMs?: number }} [options]
 */
export function execFileSyncWithDeadline(command, args, options = {}) {
  const { timeoutMs = DEFAULT_SYNC_CHILD_DEADLINE_MS, ...rest } = options;
  try {
    return execFileSync(command, args, {
      ...rest,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      detached: true,
    });
  } catch (error) {
    if (error && error.code === "ETIMEDOUT") {
      killProcessGroup(error.pid);
      throw syncDeadlineError(
        commandLabel(command, args),
        timeoutMs,
        error.stdout,
        error.stderr,
        error,
      );
    }
    throw error;
  }
}

// execSync はシェルを挟み、コマンドはシェルの孫になる（dash は1コマンドでも fork する）。グループごと止める。
/**
 * @param {string} command
 * @param {import("node:child_process").ExecSyncOptions & { timeoutMs?: number }} [options]
 */
export function execSyncWithDeadline(command, options = {}) {
  const { timeoutMs = DEFAULT_SYNC_CHILD_DEADLINE_MS, ...rest } = options;
  try {
    return execSync(command, {
      ...rest,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      detached: true,
    });
  } catch (error) {
    if (error && error.code === "ETIMEDOUT") {
      killProcessGroup(error.pid);
      throw syncDeadlineError(command, timeoutMs, error.stdout, error.stderr, error);
    }
    throw error;
  }
}
