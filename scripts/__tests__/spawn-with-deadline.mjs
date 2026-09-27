import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

/** 子が期限までに終わらなかった（close しなかった）ときに、この file の関数たちが投げる例外。 */
class ChildDeadlineError extends Error {}

/**
 * この file の関数たち（同期の3つと `runNodeScript`）が、**期限を超えたために**投げた（reject した）例外なら真。
 * 非0の終了など、それ以外の失敗には偽（文面が似ていても、この file が作った例外でなければ偽）。
 *
 * 呼び出しを `try { … } catch { … }` で包み、失敗を「無い」「skip」に読み替えている歯は、**期限の例外だけは
 * これで見分けて投げ直す。**読み替えると、止まった子が名乗らずに「skip」や「強制しない」に変わり、偽の緑になる。
 *
 * @param {unknown} error
 */
export function isDeadlineError(error) {
  return error instanceof ChildDeadlineError;
}

/** 子の close を待つ既定の期限（ミリ秒）。歯の `testTimeout`（180 秒）より十分に短くする。 */
export const DEFAULT_CHILD_DEADLINE_MS = 30_000;

/** SIGKILL の後、子の close を待つ上限（ミリ秒）。 */
const KILL_GRACE_MS = 5_000;

/**
 * 子を `detached: true` で起こしたとき（子が自分のプロセスグループの長になる）、そのグループごと SIGKILL する。
 * **子だけでなく、子が起こした孫も止める。**【実測 2026-09-28】子だけに SIGKILL を送る形では、孫が残った
 * （`spawn-deadline-grandchild.test.mjs`）。
 *
 * グループが既に無い（`ESRCH`）ときは何もしない。それ以外の例外は外へ出す。
 *
 * ⚠ **`detached: true` の副作用**: この関数たちが起こす子は、親のプロセスグループから外れる。対話の端末で Ctrl-C を
 * 押しても、その SIGINT は子（とその孫）には届かない。止めるのは、期限の kill になる。root の vitest は対話の端末を
 * 前提にしていないので、その影響は受けないと見ている。
 *
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
      // 自分のプロセスグループにして、期限を超えたら孫ごと止める（`killProcessGroup`）。
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
    // 期限を超えたら kill し、子が本当に終わった（close した）後で reject する——落ちたときに子を残さない。
    // kill しても close が来ないときのために、もう一段の上限を置く。
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
 * 同期の子が期限を超えたときに投げる例外を作る。
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
  const result = spawnSync(command, args, {
    ...rest,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: true,
  });
  if (result.error && result.error.code === "ETIMEDOUT") {
    // 同期の呼び出しの間は親のコードが走らない。期限で返った直後に、残った孫をグループごと止める。
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
    return execFileSync(command, args, {
      ...rest,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      detached: true,
    });
  } catch (error) {
    if (error && error.code === "ETIMEDOUT") {
      // 期限で返った直後に、残った孫をグループごと止める（`spawnSyncWithDeadline` と同じ）。
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

/**
 * `execSync` と同じ引数で子を起こし、**期限の内なら `execSync` と同じ戻り値（stdout）を返し、非0の終了では
 * 同じく投げる。** 期限を超えたら子をプロセスグループごと SIGKILL し、「子（コマンドの文字列）が N 秒で終わらなかった」
 * と名乗って投げる。`testTimeout` が効かないことは {@link spawnSyncWithDeadline} の doc と同じ。
 *
 * ⚠ **`execSync` はシェル（`/bin/sh -c`）を挟むので、コマンドはシェルの孫になる。**【実測 2026-09-28】
 * `"<node>" -e "setInterval(…)"; echo done` を素の `execSync(…, { timeout: 800, killSignal: "SIGKILL", detached: true })`
 * で起こすと、804 ms で ETIMEDOUT が返り（文面は `spawnSync /bin/sh ETIMEDOUT` で、コマンドも秒数も出ない）、
 * 孫の node は生きていた。`/bin/sh` が dash のとき、1つのコマンドでも fork した（孫になる）。
 * ⟹ 子だけでなく、グループごと止める（`spawn-deadline-grandchild.test.mjs`）。
 *
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
      // 期限で返った直後に、残ったシェルの孫をグループごと止める（`spawnSyncWithDeadline` と同じ）。
      killProcessGroup(error.pid);
      throw syncDeadlineError(command, timeoutMs, error.stdout, error.stderr, error);
    }
    throw error;
  }
}
