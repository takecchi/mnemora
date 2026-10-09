import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const script = fileURLToPath(
  new URL("../embedding-output-fingerprint-summary.mjs", import.meta.url),
);

let workdir;

afterEach(() => {
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

describe("embedding-output-fingerprint-summary.mjs: 非0になるのは測定 JSON が壊れているときだけ", () => {
  it("重みを取得できなかった測定（weights_unavailable）は壊れていないので、exit 0 で理由を出す", () => {
    workdir = mkdtempSync(join(tmpdir(), "embedding-fingerprint-summary-cli-"));
    const measured = join(workdir, "measured.json");
    writeFileSync(
      measured,
      JSON.stringify({
        status: "weights_unavailable",
        detail: "重みを取得できなかった: network error",
        measuredAt: "2026-09-24T00:00:00.000Z",
      }),
    );
    const result = spawnSyncWithDeadline("node", [script, "--measured", measured], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("重みを取得できなかった: network error");
  });
});
