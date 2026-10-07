import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  MANIFEST_RELATIVE_PATH,
  MIGRATIONS_RELATIVE_DIR,
  checksumOfMigrationText,
  normalizeMigrationText,
  parseManifest,
} from "../migration-checksums-lib.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repoRoot, "scripts/check-migration-checksums.mjs");
const tmpRoots = [];

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function runCli(root, ...extra) {
  return spawnSync(process.execPath, [cli, "--root", root, ...extra], { encoding: "utf8" });
}

function copyRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), "mig-checksum-edges-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "packages/postgres"), { recursive: true });
  cpSync(join(repoRoot, MIGRATIONS_RELATIVE_DIR), join(root, MIGRATIONS_RELATIVE_DIR), {
    recursive: true,
  });
  cpSync(join(repoRoot, MANIFEST_RELATIVE_PATH), join(root, MANIFEST_RELATIVE_PATH));
  return root;
}

describe("正規化は CR 単独も LF に揃える", () => {
  it("CR 単独の改行は LF と同じ hash になる", () => {
    expect(normalizeMigrationText("a\rb\r\nc\n")).toBe("a\nb\nc\n");
    expect(checksumOfMigrationText("SELECT 1;\rSELECT 2;\r")).toBe(
      checksumOfMigrationText("SELECT 1;\nSELECT 2;\n"),
    );
  });

  it("本物の migration の改行を CR 単独にしただけでは赤にならない", () => {
    const root = copyRepoFixture();
    const file = join(root, MIGRATIONS_RELATIVE_DIR, "0027_erase_tenant_fk_indexes.sql");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r"));
    expect(runCli(root).status).toBe(0);
  });

  it("途中の BOM は取らない（内容の変更として赤になる）", () => {
    const text = "SELECT 1;\n";
    expect(checksumOfMigrationText(`SELECT${String.fromCharCode(0xfeff)} 1;\n`)).not.toBe(
      checksumOfMigrationText(text),
    );
  });
});

describe("名簿の形を厳しく見る", () => {
  const sum = "a".repeat(64);

  it("`files` が配列なら拒む", () => {
    expect(() => parseManifest(JSON.stringify({ files: [sum] }))).toThrow(/files/);
  });

  it.each([
    ["63桁", "a".repeat(63)],
    ["65桁", "a".repeat(65)],
    ["大文字", "A".repeat(64)],
    ["16進でない", "g".repeat(64)],
    ["数値", 123],
    ["null", null],
  ])("値が sha256 の16進64桁でない（%s）なら、ファイル名つきで拒む", (_label, value) => {
    expect(() => parseManifest(JSON.stringify({ files: { "0001_x.sql": value } }))).toThrow(
      /0001_x\.sql/,
    );
  });

  it("正しい名簿は通す", () => {
    expect(parseManifest(JSON.stringify({ files: { "0001_x.sql": sum } }))).toEqual({
      "0001_x.sql": sum,
    });
  });

  it("名簿の値が壊れていると、門は exit 2 で止まる", () => {
    const root = copyRepoFixture();
    writeFileSync(
      join(root, MANIFEST_RELATIVE_PATH),
      JSON.stringify({ files: { "0001_init.sql": "abc" } }),
    );
    expect(runCli(root).status).toBe(2);
  });
});

describe("--write は、出荷済みの migration が消えていても名簿を書かない", () => {
  it("消えた migration があると exit 1 で、名簿は1文字も変わらない", () => {
    const root = copyRepoFixture();
    rmSync(join(root, MIGRATIONS_RELATIVE_DIR, "0005_analyze_memories.sql"));
    writeFileSync(join(root, MIGRATIONS_RELATIVE_DIR, "9999_new.sql"), "SELECT 1;\n");
    const before = readFileSync(join(root, MANIFEST_RELATIVE_PATH), "utf8");
    const result = runCli(root, "--write");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0005_analyze_memories.sql");
    expect(readFileSync(join(root, MANIFEST_RELATIVE_PATH), "utf8")).toBe(before);
  });
});

describe("ci.yml と package.json の配線（ADR 0637）", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  // YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。
  function extractJob(yaml, jobId) {
    const lines = yaml.split("\n");
    const start = lines.findIndex((line) => line === `  ${jobId}:`);
    if (start === -1) throw new Error(`ci.yml に \`  ${jobId}:\` のジョブが無い`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^ {2}\S/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end);
  }

  function stepOf(lines) {
    const runIdx = lines.findIndex((l) => /\brun:\s*pnpm run check:migration-checksums\b/.test(l));
    expect(runIdx, "check:migration-checksums の段が build ジョブに無い").toBeGreaterThan(-1);
    let start = runIdx;
    while (start > 0 && !/^ {6}- /.test(lines[start])) start -= 1;
    let end = lines.length;
    for (let i = runIdx + 1; i < lines.length; i += 1) {
      if (/^ {6}- /.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end);
  }

  const KEY = (name) => new RegExp(`(^|[\\s{,"'-])${name}["']?\\s*:`);
  const step = stepOf(extractJob(workflow, "build"));

  it("run の行は `pnpm run check:migration-checksums` だけである（`|| true` などを足さない）", () => {
    const runLine = step.find((l) => /\brun:/.test(l));
    expect(runLine.trim()).toBe("run: pnpm run check:migration-checksums");
  });

  it("段に `if:`・`continue-on-error`・`shell:` が無い", () => {
    for (const key of ["if", "continue-on-error", "shell"]) {
      expect(
        step.filter((l) => KEY(key).test(l)),
        key,
      ).toEqual([]);
    }
  });

  it("段の `name:` が在る", () => {
    expect(step.some((l) => KEY("name").test(l))).toBe(true);
  });

  it("package.json の `check:migration-checksums` は門の入口を直接呼ぶ", () => {
    expect(pkg.scripts["check:migration-checksums"]).toBe(
      "node scripts/check-migration-checksums.mjs",
    );
  });
});
