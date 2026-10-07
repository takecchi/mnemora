import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDING_FINGERPRINT_JOBS,
  EMBEDDING_FINGERPRINT_FILENAME,
} from "../compare-embedding-output-fingerprints-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const script = fileURLToPath(
  new URL("../compare-embedding-output-fingerprints.mjs", import.meta.url),
);

let workdir;

afterEach(() => {
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

function writeArtifact(dir, jobId, record) {
  const artifactName = EMBEDDING_FINGERPRINT_JOBS.find((j) => j.id === jobId).artifactName;
  const artifactDir = join(dir, artifactName);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, EMBEDDING_FINGERPRINT_FILENAME), JSON.stringify(record));
}

function runCompare(artifactsDir) {
  return spawnSyncWithDeadline("node", [script, "--artifacts-dir", artifactsDir], {
    encoding: "utf8",
  });
}

const [jobA, jobB] = EMBEDDING_FINGERPRINT_JOBS;

describe("compare-embedding-output-fingerprints.mjs の exit code(歯2)", () => {
  it("一致するときも exit 0 で、出力に「一致」を含む", () => {
    workdir = mkdtempSync(join(tmpdir(), "embedding-fingerprint-cli-match-"));
    writeArtifact(workdir, jobA.id, { status: "ok", sha256: "same", dimensions: 256, cpuInfo: {} });
    writeArtifact(workdir, jobB.id, { status: "ok", sha256: "same", dimensions: 256, cpuInfo: {} });
    const result = runCompare(workdir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("一致");
  });

  it("不一致でも exit 0 のままで、出力に「不一致」を含む(⛔ 門にしていないことの固定)", () => {
    workdir = mkdtempSync(join(tmpdir(), "embedding-fingerprint-cli-mismatch-"));
    writeArtifact(workdir, jobA.id, {
      status: "ok",
      sha256: "aaa",
      dimensions: 256,
      cpuInfo: { "Model name": "cpu-a" },
    });
    writeArtifact(workdir, jobB.id, {
      status: "ok",
      sha256: "bbb",
      dimensions: 256,
      cpuInfo: { "Model name": "cpu-b" },
    });
    const result = runCompare(workdir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("不一致");
  });

  it("片方の artifact が無いときも exit 0 のままで、「比較できなかった」を含む(歯3)", () => {
    workdir = mkdtempSync(join(tmpdir(), "embedding-fingerprint-cli-missing-"));
    writeArtifact(workdir, jobA.id, { status: "ok", sha256: "aaa", dimensions: 256, cpuInfo: {} });
    const result = runCompare(workdir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("比較できなかった");
    expect(result.stdout).not.toContain("✅ 一致");
  });

  it("両方の artifact が無いときも exit 0 のままで、「比較できなかった」を含む", () => {
    workdir = mkdtempSync(join(tmpdir(), "embedding-fingerprint-cli-both-missing-"));
    mkdirSync(workdir, { recursive: true });
    const result = runCompare(workdir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("比較できなかった");
  });

  it("--artifacts-dir を渡し忘れると非0で終わる(CLI の誤用。比較結果ではない)", () => {
    const result = spawnSyncWithDeadline("node", [script], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});
