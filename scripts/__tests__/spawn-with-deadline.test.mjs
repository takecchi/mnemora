import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "./spawn-with-deadline.mjs";

function withScript(source, fn) {
  const dir = mkdtempSync(join(tmpdir(), "spawn-with-deadline-"));
  const script = join(dir, "child.mjs");
  writeFileSync(script, source);
  return Promise.resolve(fn(script)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runNodeScript: 子の close を待つ期限", () => {
  it("終わる子は、終了コード・stdout・stderr をそのまま返す", async () => {
    await withScript(
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);\n',
      async (script) => {
        const r = await runNodeScript(script, [], { timeoutMs: 20_000 });
        expect(r).toEqual({ code: 3, stdout: "out", stderr: "err" });
      },
    );
  });

  it("期限までに close しない子は kill し、「N 秒で close しなかった」と名乗って落ちる", async () => {
    await withScript(
      "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);\n",
      async (script) => {
        const started = Date.now();
        let pid;
        const error = await runNodeScript(script, ["--x"], {
          timeoutMs: 1_000,
          onSpawn: (child) => (pid = child.pid),
        }).then(
          () => null,
          (e) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain("1 秒で close しなかった");
        expect(error.message).toContain("child.mjs --x");
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(pid).toBeTypeOf("number");
        expect(isAlive(pid)).toBe(false);
      },
    );
  }, 15_000); // この歯自身の上限（testTimeout は延ばさない。期限の無い形なら、ここで赤くなる）。
});
