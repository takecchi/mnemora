import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/openai-arm-summary.mjs` の歯。**本物のスクリプトを子プロセスとして実際に
 * 起動する**(`identifier-probe-summary.test.mjs` と同じ形・同じ理由)。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **基準値と相違しても exit 0**(⛔ 門ではない)。
 * 2. **`--measured` のファイルが無くても exit 0**(openai arm ブロックが失敗して
 *    JSON が1件も書かれなかった場合を、入力破損と同じ顔で落とさない)。
 * 3. **入力そのものが壊れていれば非0**。
 * 4. **並走の判定(red/green)が red でも exit 0**——判定は Markdown に載るだけで
 *    exit code には反映しない。
 */

const script = fileURLToPath(new URL("../openai-arm-summary.mjs", import.meta.url));

function makeGroup(overrides = {}) {
  return {
    group: "identifiersSparse",
    label:
      "identifier-probes/identifiers-sparse(llm=deterministic, embedding=recorded/text-embedding-3-small/256次元, haystack=sparse)",
    llmMode: "deterministic",
    embeddingMode: "recorded",
    embeddingSpace: { provider: "openai", model: "text-embedding-3-small", dimensions: 256 },
    haystackKind: "sparse",
    mrrOverall: 0.84,
    hit1Count: 21,
    hit10Count: 30,
    probeCount: 30,
    ...overrides,
  };
}

function makeMeasured(groups) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-25T00:00:00.000Z",
    commit: "abc123",
    groups,
  };
}

let dir;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function writeJson(name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function run(args) {
  return spawnSync("node", [script, ...args], { encoding: "utf-8" });
}

describe("openai-arm-summary.mjs(CLI)", () => {
  it("--measured/--title が無ければ exit 1", () => {
    const result = run([]);
    expect(result.status).toBe(1);
  });

  it("--measured のファイルが無ければ exit 0(入力破損とは区別する)", () => {
    dir = mkdtempSync(join(tmpdir(), "openai-arm-summary-"));
    const result = run(["--title", "テスト", "--measured", join(dir, "nope.json")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("実測 JSON が無い");
  });

  it("measured の JSON が parse できなければ exit 1", () => {
    dir = mkdtempSync(join(tmpdir(), "openai-arm-summary-"));
    const path = join(dir, "measured.json");
    writeFileSync(path, "{not json");
    const result = run(["--title", "テスト", "--measured", path]);
    expect(result.status).toBe(1);
  });

  it("measured が正しく baseline と一致すれば exit 0、markdown に一致・green が出る", () => {
    dir = mkdtempSync(join(tmpdir(), "openai-arm-summary-"));
    const group = makeGroup();
    const measuredPath = writeJson("measured.json", makeMeasured([group]));
    const baselinePath = writeJson("baseline.json", { groups: [group] });
    const result = run([
      "--title",
      "テスト",
      "--measured",
      measuredPath,
      "--baseline",
      baselinePath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅ 一致");
    expect(result.stdout).toContain("✅ 0/1 群が red");
  });

  it("基準値と相違しても exit 0(⛔ 門ではない)", () => {
    dir = mkdtempSync(join(tmpdir(), "openai-arm-summary-"));
    const measuredPath = writeJson("measured.json", makeMeasured([makeGroup({ mrrOverall: 0.1 })]));
    const baselinePath = writeJson("baseline.json", { groups: [makeGroup()] });
    const result = run([
      "--title",
      "テスト",
      "--measured",
      measuredPath,
      "--baseline",
      baselinePath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("🔴 1/1 群が red");
  });

  it("baseline の JSON が壊れていれば exit 1", () => {
    dir = mkdtempSync(join(tmpdir(), "openai-arm-summary-"));
    const measuredPath = writeJson("measured.json", makeMeasured([makeGroup()]));
    const baselinePath = join(dir, "baseline.json");
    writeFileSync(baselinePath, "{not json");
    const result = run([
      "--title",
      "テスト",
      "--measured",
      measuredPath,
      "--baseline",
      baselinePath,
    ]);
    expect(result.status).toBe(1);
  });
});
