import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decideDryRun } from "../publish-dry-run.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * 「危険と明示されたときだけ本番」の、明示に近いが一致しない入力を押さえる。
 * 大文字小文字・前後の空白の違いや、env が渡らなかった形を、本番の側へ寄せて読まないこと。
 */

const script = fileURLToPath(new URL("../decide-publish-dry-run.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {string | undefined} */
let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe("decideDryRun —— 明示に近いだけの値は、予行に倒す", () => {
  it.each(["Release", "RELEASE", " release"])(
    "event_name=%j は release として扱わない",
    (eventName) => {
      const result = decideDryRun({ eventName, dryRunInput: "false" });
      expect(result.dryRun).toBe(true);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each([" false", "false ", "false\n"])(
    "workflow_dispatch × dry_run=%j は予行",
    (dryRunInput) => {
      const result = decideDryRun({ eventName: "workflow_dispatch", dryRunInput });
      expect(result.dryRun).toBe(true);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    },
  );
});

describe("decide-publish-dry-run.mjs —— EVENT_NAME が env に渡らなかったら予行", () => {
  it("EVENT_NAME も DRY_RUN_INPUT も無い ⟹ GITHUB_OUTPUT に dry_run=true、::warning:: が出る", () => {
    workDir = mkdtempSync(join(tmpdir(), "decide-publish-dry-run-no-event-"));
    const githubOutput = join(workDir, "github_output");
    writeFileSync(githubOutput, "");
    const env = { ...process.env, GITHUB_OUTPUT: githubOutput };
    delete env.EVENT_NAME;
    delete env.DRY_RUN_INPUT;

    const result = spawnSyncWithDeadline(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(githubOutput, "utf8")).toBe("dry_run=true\n");
    expect(result.stdout).toContain("::warning::");
  });
});
