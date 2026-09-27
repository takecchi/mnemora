import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "./spawn-with-deadline.mjs";

/**
 * `runNodeScript` は、子が期限までに close しなければ子を kill し、「N 秒で close しなかった」と名乗って落ちる。
 *
 * 【実測 2026-09-28】`local-embedding-cache-key.test.mjs` の CLI（引数を読んで exit 3 するだけ）が、負荷の下で
 * 子の node のプロセスごと止まり（全スレッドが futex / epoll で待ったまま、exit に至らない）、`close` を待つ歯が
 * `testTimeout`（180 秒）まで何も言わずに待っていた。止まる原因は子の node の内側にあり、ここでは断定していない。
 * この関数は、止まりを「診断できる失敗」に変える——期限を超えたら子を kill し、何を何秒待ったかを名乗る。
 */

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
        // 期限の近くで落ちる（testTimeout まで待たない）。
        expect(Date.now() - started).toBeLessThan(10_000);
        // 子を残さない。
        expect(pid).toBeTypeOf("number");
        expect(isAlive(pid)).toBe(false);
      },
    );
  }, // この歯自身の上限（testTimeout は延ばさない。期限の無い形なら、ここで赤くなる）。
  15_000);
});
