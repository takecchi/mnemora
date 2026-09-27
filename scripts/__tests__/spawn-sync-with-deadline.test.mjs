import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSyncWithDeadline, spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * 同期の子（`spawnSync`・`execFileSync`）の期限。期限の内は素の関数と同じ戻り値を返し、期限を超えたら子を kill して
 * 「子（コマンド 引数）が N 秒で終わらなかった」と名乗って投げる。
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
});
