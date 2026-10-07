import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWED_NON_ADR_MARKDOWN,
  GENERATED_END_MARKER,
  GENERATED_START_MARKER,
  assertWellFormedAdrFilenames,
  spliceGeneratedIndex,
} from "../generate-adr-index-lib.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));

const adr = (number, title, state = "採用 (2026-10)") =>
  `# ADR ${number}: ${title}\n\n- **状態**: ${state}\n- **日付**: 2026-10-07\n`;

describe("generate-adr-index-lib: 生成器が README を壊さない", () => {
  const readme = `手書き\n${GENERATED_START_MARKER}\n古い表\n${GENERATED_END_MARKER}\n結び\n`;

  it("自分の出力にもう一度かけても、1バイトも変わらない（--check が収束する）", () => {
    const once = spliceGeneratedIndex(readme, "新しい表");
    expect(spliceGeneratedIndex(once, "新しい表")).toBe(once);
  });

  it("END マーカーが START より前に在れば、書き換えずに例外", () => {
    const reversed = `${GENERATED_END_MARKER}\n${GENERATED_START_MARKER}\n`;
    expect(() => spliceGeneratedIndex(reversed, "表")).toThrow(/END マーカーが START より前/);
  });

  it("START だけが2つ在っても（END は1つ）、マーカーが2組以上として例外", () => {
    const text = `${GENERATED_START_MARKER}\n${GENERATED_START_MARKER}\n${GENERATED_END_MARKER}\n`;
    expect(() => spliceGeneratedIndex(text, "表")).toThrow(/2組以上/);
  });

  it("END だけが2つ在っても（START は1つ）、マーカーが2組以上として例外", () => {
    const text = `${GENERATED_START_MARKER}\n${GENERATED_END_MARKER}\n${GENERATED_END_MARKER}\n`;
    expect(() => spliceGeneratedIndex(text, "表")).toThrow(/2組以上/);
  });
});

describe("assertWellFormedAdrFilenames: ADR でない .md を許すのは README.md と TEMPLATE.md だけ", () => {
  it("許す一覧は README.md と TEMPLATE.md の2つだけである", () => {
    expect(ALLOWED_NON_ADR_MARKDOWN).toEqual(["README.md", "TEMPLATE.md"]);
  });

  it.each(["NOTES.md", "CONTRIBUTING.md", "draft.md"])("%s は ADR の形でないので例外", (name) => {
    expect(() => assertWellFormedAdrFilenames([name])).toThrow(name);
  });
});

describe("generate-adr-index.mjs（子プロセス。作業木を一時ディレクトリへ写して走らせる）", () => {
  /** @type {string[]} */
  const roots = [];
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {Record<string, string>} adrFiles `docs/decisions/` に置くファイル（README.md を除く）
   * @param {string} readme
   */
  function setup(adrFiles, readme) {
    const root = mkdtempSync(join(tmpdir(), "generate-adr-index-"));
    roots.push(root);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    for (const file of ["generate-adr-index.mjs", "generate-adr-index-lib.mjs"]) {
      copyFileSync(join(scriptsDir, file), join(root, "scripts", file));
    }
    for (const [name, content] of Object.entries(adrFiles)) {
      writeFileSync(join(root, "docs", "decisions", name), content);
    }
    const readmePath = join(root, "docs", "decisions", "README.md");
    writeFileSync(readmePath, readme);
    return {
      addAdr: (name, content) => writeFileSync(join(root, "docs", "decisions", name), content),
      readme: () => readFileSync(readmePath, "utf8"),
      run: (...args) =>
        spawnSyncWithDeadline(
          process.execPath,
          [join(root, "scripts", "generate-adr-index.mjs"), ...args],
          {
            encoding: "utf8",
          },
        ),
    };
  }

  const shell = `# 索引\n\n${GENERATED_START_MARKER}\n${GENERATED_END_MARKER}\n\n手書きの結び\n`;
  const files = {
    "0002-second.md": adr("0002", "二番目", "提案 (2026-10)"),
    "0001-first.md": adr("0001", "一番目"),
    "TEMPLATE.md": "# ADR NNNN: 題\n",
    ".gitkeep": "",
    "notes.txt": "ADR ではないメモ\n",
  };

  it("索引が古ければ README の生成部分だけを書き換えて exit 0 し、番号順に ADR だけを並べる", () => {
    const sandbox = setup(files, shell);
    const r = sandbox.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("更新しました（ADR 2 本）");
    const text = sandbox.readme();
    expect(text.startsWith("# 索引\n")).toBe(true);
    expect(text.endsWith("手書きの結び\n")).toBe(true);
    expect(text).toContain("| [0001](./0001-first.md) | 一番目 | 採用 (2026-10) |");
    expect(text).toContain("| [0002](./0002-second.md) | 二番目 | **提案 (2026-10)** |");
    expect(text.indexOf("[0001]")).toBeLessThan(text.indexOf("[0002]"));
    expect(text).not.toContain("TEMPLATE");
    expect(text).not.toContain("notes.txt");
    expect(text).not.toContain("README.md)");
  });

  it("書き換えた後にもう一度走らせると、最新と言って README を変えない", () => {
    const sandbox = setup(files, shell);
    sandbox.run();
    const generated = sandbox.readme();
    const r = sandbox.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("最新です（ADR 2 本）");
    expect(sandbox.readme()).toBe(generated);
  });

  it("--check は、索引が古ければ README を書き換えず exit 1 で、直し方（生成器の実行）を言う", () => {
    const sandbox = setup(files, shell);
    const r = sandbox.run("--check");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("node scripts/generate-adr-index.mjs");
    expect(r.stderr).toContain("ADR は 2 本");
    expect(sandbox.readme()).toBe(shell);
  });

  it("--check は、索引が最新なら exit 0 で何も書き換えない", () => {
    const sandbox = setup(files, shell);
    sandbox.run();
    const generated = sandbox.readme();
    const r = sandbox.run("--check");
    expect(r.status).toBe(0);
    expect(sandbox.readme()).toBe(generated);
  });

  it("ADR を1本足すと、--check は赤くなり、再生成すると新しい行が増えて緑に戻る", () => {
    const sandbox = setup(files, shell);
    sandbox.run();
    sandbox.addAdr("0003-third.md", adr("0003", "三番目"));
    expect(sandbox.run("--check").status).toBe(1);
    expect(sandbox.run().status).toBe(0);
    expect(sandbox.readme()).toContain("| [0003](./0003-third.md) | 三番目 | 採用 (2026-10) |");
    expect(sandbox.run("--check").status).toBe(0);
  });

  it.each([[[]], [["--check"]]])(
    "同じ番号を2本が名乗っていれば、%j でも失敗して README を変えない",
    (args) => {
      const sandbox = setup({ ...files, "0001-other.md": adr("0001", "別の一番目") }, shell);
      const r = sandbox.run(...args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("0001-first.md");
      expect(r.stderr).toContain("0001-other.md");
      expect(sandbox.readme()).toBe(shell);
    },
  );

  it.each([[[]], [["--check"]]])("番号が欠けていても重複でなければ、%j は成功する", (args) => {
    const sandbox = setup(
      { "0001-first.md": adr("0001", "一番目"), "0005-fifth.md": adr("0005", "五番目") },
      shell,
    );
    sandbox.run();
    expect(sandbox.run(...args).status).toBe(0);
  });

  it("壊れた ADR（見出しの番号がファイル名と食い違う）が在れば、失敗して README を変えない", () => {
    const sandbox = setup({ ...files, "0003-third.md": adr("0004", "食い違い") }, shell);
    const r = sandbox.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("0003-third.md");
    expect(sandbox.readme()).toBe(shell);
  });

  it("README にマーカーが無ければ、失敗して README を変えない", () => {
    const sandbox = setup(files, "# 索引\n");
    const r = sandbox.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("マーカー");
    expect(sandbox.readme()).toBe("# 索引\n");
  });
});
