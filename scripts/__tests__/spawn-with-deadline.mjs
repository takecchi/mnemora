import { spawn } from "node:child_process";
import { basename } from "node:path";

/** 子の close を待つ既定の期限（ミリ秒）。歯の `testTimeout`（180 秒）より十分に短くする。 */
export const DEFAULT_CHILD_DEADLINE_MS = 30_000;

/** SIGKILL の後、子の close を待つ上限（ミリ秒）。 */
const KILL_GRACE_MS = 5_000;

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
