import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  execFileSyncWithDeadline,
  execSyncWithDeadline,
  isDeadlineError,
  runNodeScript,
  spawnSyncWithDeadline,
} from "./spawn-with-deadline.mjs";

/**
 * 同期の子（`spawnSync`・`execFileSync`・`execSync`）の期限。期限の内は素の関数と同じ戻り値を返し、期限を超えたら
 * 子を kill して「子（コマンド 引数）が N 秒で終わらなかった」と名乗って投げる。
 */

function withScript(source, fn) {
  const dir = mkdtempSync(join(tmpdir(), "spawn-sync-with-deadline-"));
  const script = join(dir, "child.mjs");
  const pidFile = join(dir, "pid");
  writeFileSync(script, source.replaceAll("PID_FILE", JSON.stringify(pidFile)));
  try {
    return fn(script, pidFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HANGS =
  'import { writeFileSync } from "node:fs"; writeFileSync(PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\n';
const EXITS = 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);\n';

describe("spawnSyncWithDeadline / execFileSyncWithDeadline: 同期の子の期限", () => {
  it("期限の内: spawnSync と同じ status・stdout・stderr を返す", () => {
    withScript(EXITS, (script) => {
      const plain = spawnSync(process.execPath, [script], { encoding: "utf8" });
      const r = spawnSyncWithDeadline(process.execPath, [script], { encoding: "utf8" });
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error }).toEqual({
        status: plain.status,
        stdout: plain.stdout,
        stderr: plain.stderr,
        error: plain.error,
      });
    });
  });

  it("期限の内: execFileSync と同じ stdout を返す（非0なら同じく投げる）", () => {
    withScript('process.stdout.write("ok");\n', (script) => {
      expect(execFileSyncWithDeadline(process.execPath, [script], { encoding: "utf8" })).toBe(
        execFileSync(process.execPath, [script], { encoding: "utf8" }),
      );
    });
    withScript(EXITS, (script) => {
      expect(() => execFileSyncWithDeadline(process.execPath, [script], { stdio: "pipe" })).toThrow(
        /Command failed/,
      );
    });
  });

  for (const [label, call] of [
    [
      "spawnSyncWithDeadline",
      (script) => spawnSyncWithDeadline(process.execPath, [script, "--x"], { timeoutMs: 1_000 }),
    ],
    [
      "execFileSyncWithDeadline",
      (script) =>
        execFileSyncWithDeadline(process.execPath, [script, "--x"], {
          timeoutMs: 1_000,
          stdio: "pipe",
        }),
    ],
  ]) {
    it(`${label}: 期限を超えた子は kill し、「何を何秒待ったか」を名乗って投げる`, () => {
      withScript(HANGS, (script, pidFile) => {
        const started = Date.now();
        let error = null;
        try {
          call(script);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain("1 秒で終わらなかった");
        expect(error.message).toContain("child.mjs --x");
        expect(Date.now() - started).toBeLessThan(10_000);
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(isAlive(pid)).toBe(false);
      });
    });
  }

  it("期限の内: execSync と同じ stdout を返す（非0なら同じく投げる）", () => {
    withScript('process.stdout.write("ok");\n', (script) => {
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
      expect(execSyncWithDeadline(command, { encoding: "utf8" })).toBe(
        execSync(command, { encoding: "utf8" }),
      );
    });
    withScript(EXITS, (script) => {
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
      expect(() => execSyncWithDeadline(command, { stdio: "pipe" })).toThrow(/Command failed/);
    });
  });

  it("execSyncWithDeadline: 期限を超えた子は kill し、「何を何秒待ったか」を名乗って投げる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-sync-with-deadline-"));
    const script = join(dir, "child.mjs");
    const pidFile = join(dir, "pid");
    writeFileSync(script, HANGS.replaceAll("PID_FILE", JSON.stringify(pidFile)));
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} --x`;
    let pid;
    try {
      const started = Date.now();
      let error = null;
      try {
        execSyncWithDeadline(command, { timeoutMs: 1_000, stdio: "pipe" });
      } catch (e) {
        error = e;
      }
      // 落ちたときにも止められるよう、先に pid を読む。
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("1 秒で終わらなかった");
      // 文字列のコマンドは、そのまま名乗る（引数に分けない）。
      expect(error.message).toContain(`子（${command}）`);
      expect(Date.now() - started).toBeLessThan(10_000);
      // `/bin/sh` は1つのコマンドでも fork することがあり（dash で実測）、その node は子ではなく孫になる。
      // 孫への SIGKILL の配達は非同期なので、死ぬまで少し待つ（上限つき）。
      const until = Date.now() + 3_000;
      while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("isDeadlineError: 期限の例外だけを見分ける", () => {
  function thrownBy(call) {
    try {
      call();
    } catch (e) {
      return e;
    }
    throw new Error("投げなかった");
  }

  it("3つの同期の関数が期限を超えて投げた例外には真", () => {
    withScript(HANGS, (script, pidFile) => {
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
      // 最後に起こした子（`execSync` はシェルの孫）が残っていれば止める。
      const stopLast = () => {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      };
      const errors = [];
      try {
        errors.push(
          thrownBy(() => spawnSyncWithDeadline(process.execPath, [script], { timeoutMs: 500 })),
          thrownBy(() =>
            execFileSyncWithDeadline(process.execPath, [script], { timeoutMs: 500, stdio: "pipe" }),
          ),
          thrownBy(() => execSyncWithDeadline(command, { timeoutMs: 500, stdio: "pipe" })),
        );
      } finally {
        stopLast();
      }
      expect(errors.map(isDeadlineError)).toEqual([true, true, true]);
    });
  });

  it("runNodeScript が期限を超えて reject した例外には真", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-sync-with-deadline-"));
    const script = join(dir, "child.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    try {
      const error = await runNodeScript(script, [], { timeoutMs: 500 }).then(
        () => null,
        (e) => e,
      );
      expect(isDeadlineError(error)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("非0の終了で投げた例外・ほかの例外・例外でない値には偽", () => {
    withScript(EXITS, (script) => {
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
      expect(
        isDeadlineError(
          thrownBy(() => execFileSyncWithDeadline(process.execPath, [script], { stdio: "pipe" })),
        ),
      ).toBe(false);
      expect(isDeadlineError(thrownBy(() => execSyncWithDeadline(command, { stdio: "pipe" })))).toBe(
        false,
      );
    });
    expect(isDeadlineError(new Error("子（x）が 1 秒で終わらなかった"))).toBe(false);
    expect(isDeadlineError(undefined)).toBe(false);
    expect(isDeadlineError({ code: "ETIMEDOUT" })).toBe(false);
  });
});
