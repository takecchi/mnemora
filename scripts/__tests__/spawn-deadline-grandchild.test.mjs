import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  execFileSyncWithDeadline,
  execSyncWithDeadline,
  killProcessGroup,
  runNodeScript,
  spawnSyncWithDeadline,
} from "./spawn-with-deadline.mjs";

// 子だけに SIGKILL を送る形では孫が残る（bash が2つ目のコマンドを持つと fork するため）。

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function diesWithin(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "spawn-deadline-grandchild-"));
  const pidFile = join(dir, "grandchild.pid");
  const grandchild = join(dir, "grandchild.mjs");
  writeFileSync(
    grandchild,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
  );
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { spawn } from "node:child_process"; spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(() => {}, 1000);\n`,
  );
  const bashScript = `${JSON.stringify(process.execPath)} ${JSON.stringify(grandchild)}; echo done`;
  return { dir, pidFile, child, bashScript };
}

async function grandchildPid(pidFile) {
  const until = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return Number(readFileSync(pidFile, "utf8"));
}

describe("期限を超えて止めたとき、孫も残らない", () => {
  it("spawnSyncWithDeadline（bash が孫を起こす）", async () => {
    const { dir, pidFile, bashScript } = setup();
    let pid;
    try {
      expect(() => spawnSyncWithDeadline("bash", ["-c", bashScript], { timeoutMs: 1_500 })).toThrow(
        /秒で終わらなかった/,
      );
      pid = await grandchildPid(pidFile);
      expect(await diesWithin(pid, 3_000)).toBe(true);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("execFileSyncWithDeadline（bash が孫を起こす）", async () => {
    const { dir, pidFile, bashScript } = setup();
    let pid;
    try {
      expect(() =>
        execFileSyncWithDeadline("bash", ["-c", bashScript], { timeoutMs: 1_500, stdio: "pipe" }),
      ).toThrow(/秒で終わらなかった/);
      pid = await grandchildPid(pidFile);
      expect(await diesWithin(pid, 3_000)).toBe(true);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("execSyncWithDeadline（シェルが孫を起こす）", async () => {
    const { dir, pidFile, bashScript } = setup();
    let pid;
    try {
      expect(() => execSyncWithDeadline(bashScript, { timeoutMs: 1_500, stdio: "pipe" })).toThrow(
        /秒で終わらなかった/,
      );
      pid = await grandchildPid(pidFile);
      expect(await diesWithin(pid, 3_000)).toBe(true);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("runNodeScript（node の子が孫を起こす）", async () => {
    const { dir, pidFile, child } = setup();
    let pid;
    try {
      await expect(runNodeScript(child, [], { timeoutMs: 1_500 })).rejects.toThrow(
        /秒で close しなかった/,
      );
      pid = await grandchildPid(pidFile);
      expect(await diesWithin(pid, 3_000)).toBe(true);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("killProcessGroup: グループへの kill の例外の扱い", () => {
  const failing = (code) => () => {
    throw Object.assign(new Error(`fake ${code}`), { code });
  };

  it("負の pid（グループ）へ SIGKILL を送る", () => {
    const calls = [];
    killProcessGroup(1234, (pid, signal) => calls.push([pid, signal]));
    expect(calls).toEqual([[-1234, "SIGKILL"]]);
  });

  it("グループが既に無い（ESRCH）ときは握りつぶす", () => {
    expect(() => killProcessGroup(1234, failing("ESRCH"))).not.toThrow();
  });

  it("それ以外の例外（EPERM など）は外へ出す", () => {
    expect(() => killProcessGroup(1234, failing("EPERM"))).toThrow(/fake EPERM/);
  });

  it("pid が無ければ何もしない", () => {
    const calls = [];
    killProcessGroup(undefined, (pid) => calls.push(pid));
    expect(calls).toEqual([]);
  });
});
