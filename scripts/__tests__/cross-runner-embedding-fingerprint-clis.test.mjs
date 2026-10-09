import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDING_FINGERPRINT_FILENAME } from "../compare-embedding-output-fingerprints-lib.mjs";
import {
  CROSS_RUNNER_BASELINE_LEG_ID,
  allExpectedCrossRunnerLegs,
} from "../cross-runner-embedding-fingerprint-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const measureScript = fileURLToPath(
  new URL("../measure-cross-runner-embedding-fingerprint.mjs", import.meta.url),
);
const compareScript = fileURLToPath(
  new URL("../compare-cross-runner-embedding-fingerprints.mjs", import.meta.url),
);

let workdir;

afterEach(() => {
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

describe("measure-cross-runner-embedding-fingerprint.mjs: 非0になるのは --raw が測定結果として使えないときだけ", () => {
  it("重みを取得できなかった生測定（weights_unavailable）は exit 0 で、その status のまま書き出す", () => {
    workdir = mkdtempSync(join(tmpdir(), "cross-runner-measure-cli-"));
    const raw = join(workdir, "raw.json");
    const out = join(workdir, "out.json");
    writeFileSync(raw, JSON.stringify({ status: "weights_unavailable", detail: "重みが無い" }));
    const result = spawnSyncWithDeadline(
      "node",
      [measureScript, "--raw", raw, "--out", out, "--runner-label", "ubuntu-latest", "--rep", "1"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.status).toBe("weights_unavailable");
    expect(written.detail).toBe("重みが無い");
    expect(written.runnerLabel).toBe("ubuntu-latest");
    expect(written.rep).toBe(1);
  });
});

describe("compare-cross-runner-embedding-fingerprints.mjs: 群の要約は実測の arch を信じる", () => {
  it("記録の arch が宣言と違えば、脚の arch は実測の値になり、食い違いとして残る", () => {
    workdir = mkdtempSync(join(tmpdir(), "cross-runner-compare-cli-"));
    const artifactsDir = join(workdir, "artifacts");
    const baseline = allExpectedCrossRunnerLegs().find(
      (leg) => leg.id === CROSS_RUNNER_BASELINE_LEG_ID,
    );
    const declaredArch = baseline.arch;
    const actualArch = declaredArch === "x64" ? "arm64" : "x64";
    const legDir = join(artifactsDir, baseline.artifactName);
    mkdirSync(legDir, { recursive: true });
    writeFileSync(
      join(legDir, EMBEDDING_FINGERPRINT_FILENAME),
      JSON.stringify({ status: "weights_unavailable", detail: "重みが無い", arch: actualArch }),
    );
    const jsonOut = join(workdir, "summary.json");
    const result = spawnSyncWithDeadline(
      "node",
      [compareScript, "--artifacts-dir", artifactsDir, "--json-out", jsonOut],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(jsonOut, "utf8"));
    expect(summary.legs.find((leg) => leg.id === baseline.id).arch).toBe(actualArch);
    expect(summary.archMismatches).toEqual([{ id: baseline.id, declaredArch, actualArch }]);
  });
});
