import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGES } from "../publish-gates.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * publish.yml の門の段は「Typecheck / Lint / Format / Test / Build」を名乗る。
 * 既定の段（`STAGES`）からどれかが抜けても、走らせ方を測る歯（偽の段に差し替える）は緑のままなので、
 * 既定の中身はここで押さえる。順序と数は縛らない（足すことは止めない）。
 */

const script = fileURLToPath(new URL("../run-publish-gates.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const rootScripts = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).scripts;

describe("publish の門の既定の段は、名乗っている5つのルートの script を本当に走らせる", () => {
  it.each(["typecheck", "lint", "format:check", "test", "build"])(
    "`pnpm run %s` を打つ段が在り、その script がルートの package.json に在る",
    (name) => {
      expect(STAGES).toContainEqual(
        expect.objectContaining({ command: "pnpm", args: ["run", name] }),
      );
      expect(rootScripts, `ルートの package.json に ${name} が無い`).toHaveProperty([name]);
    },
  );
});

describe("signal で死んだ段は、成功として数えない", () => {
  it("段が SIGKILL で終わると、門は非0で終わり、その段を失敗として名指しする", () => {
    const stages = [
      { name: "ok", command: process.execPath, args: ["-e", "process.exit(0)"] },
      {
        name: "killed",
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
      },
    ];
    const r = spawnSyncWithDeadline(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      // publish の job の中では GITHUB_WORKFLOW が Publish になり、差し替えが断られるので上書きする。
      env: {
        ...process.env,
        GITHUB_WORKFLOW: "test-of-run-publish-gates",
        MNEMORA_PUBLISH_GATE_STAGES_JSON: JSON.stringify(stages),
      },
    });

    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("失敗した段: killed");
  });
});
