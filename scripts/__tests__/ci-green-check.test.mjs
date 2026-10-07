import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/** `gh` を呼ぶ経路は検査しない。CI のこのジョブに認証済み `gh` の保証が無く、歯が赤いのか `gh` が届いていないのかを区別できなくなる。 */

const script = fileURLToPath(new URL("../ci-green-check.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function run(args) {
  return spawnSyncWithDeadline(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("scripts/ci-green-check.mjs（gh を呼ぶ前に決着する経路）", () => {
  it("--pr も --sha も無ければ使い方を出して exit 3", () => {
    const result = run([]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--pr");
    expect(result.stderr).toContain("--sha");
  });

  it("未知のフラグは exit 3 で名指しして落ちる", () => {
    const result = run(["--not-a-real-flag"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--not-a-real-flag");
  });
});
