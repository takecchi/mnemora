import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  commentTextOf,
  findBrokenReferences,
  formatBrokenReferences,
  headingNumbersOf,
  maskMarkdownCodeFences,
} from "../doc-reference-lib.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// `.tmp` は `.gitignore` 済みの作業場所。並行に走る歯が一時ファイルを作っては消すので歩かない（末尾の歯）。
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".tmp"]);

function toRepoRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(toRepoRelative(full));
  }
  return acc;
}

const ALL_FILES = walk(REPO_ROOT);
const ALL_SET = new Set(ALL_FILES);
const ALL_DIRS = new Set(
  ALL_FILES.flatMap((f) =>
    f
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
  ),
);
const ADR_NUMBERS = new Set(
  ALL_FILES.filter((f) => /^docs\/decisions\/\d{4}-[^/]*\.md$/.test(f)).map((f) =>
    path.basename(f).slice(0, 4),
  ),
);

const headingCache = new Map();
/** @type {import("../doc-reference-lib.mjs").ReferenceEnv} */
const REPO_ENV = {
  exists: (p) => p === "" || ALL_SET.has(p) || ALL_DIRS.has(p),
  adrExists: (n) => ADR_NUMBERS.has(n),
  headingNumbers: (p) => {
    if (!p.endsWith(".md") || !ALL_SET.has(p)) return null;
    if (!headingCache.has(p)) {
      headingCache.set(p, headingNumbersOf(readFileSync(path.join(REPO_ROOT, p), "utf8")));
    }
    return headingCache.get(p);
  },
};

function isLivingMarkdown(f) {
  if (!f.endsWith(".md")) return false;
  if (f.startsWith("docs/decisions/")) return false;
  return f.startsWith("docs/") || f === "AGENTS.md" || path.basename(f) === "README.md";
}
function isLivingTs(f) {
  return /^packages\/[^/]+\/src\/.*\.ts$/.test(f) && !f.includes("/__tests__/");
}

function livingText(f) {
  const raw = readFileSync(path.join(REPO_ROOT, f), "utf8");
  return f.endsWith(".md") ? maskMarkdownCodeFences(raw) : commentTextOf(raw);
}

const LIVING_FILES = ALL_FILES.filter((f) => isLivingMarkdown(f) || isLivingTs(f));

describe("🔴 門: 生きた文書の参照が、指す先に届く（相対リンク・ADR 番号・<file>.md §N）", () => {
  it("生きた文書のどこにも、指す先に届かない参照が無い", () => {
    const broken = LIVING_FILES.flatMap((f) => findBrokenReferences(f, livingText(f), REPO_ENV));
    expect(formatBrokenReferences(broken)).toBe("");
  });

  it("⭐ 何も見ていない、にならない: 生きた文書を実際に読んでいる（markdown と TS のコメントの両方）", () => {
    expect(LIVING_FILES.some((f) => f === "AGENTS.md")).toBe(true);
    expect(LIVING_FILES.some((f) => f === "docs/recall.md")).toBe(true);
    expect(LIVING_FILES.some((f) => f === "packages/core/src/runtime.ts")).toBe(true);
    expect(LIVING_FILES.some((f) => f.startsWith("docs/decisions/"))).toBe(false);
    expect(livingText("packages/core/src/runtime.ts")).toMatch(
      /\]\(\.\.\/\.\.\/\.\.\/docs\/decisions\//,
    );
  });
});

describe("陽性対照: 腐った参照を1つ入れた入力は赤になり、正しい参照は赤にならない（実物の repo を env にする）", () => {
  const FILE = "docs/recall.md";

  it("相対リンク: 存在しない先は赤、在る先は赤にならない", () => {
    const broken = findBrokenReferences(
      FILE,
      "正しい [ADR 0084](./decisions/0084-lexical-recall-channel.md)\n腐った [x](./decisions/9999-no-such-adr.md#a)\n",
      REPO_ENV,
    );
    expect(broken.map((b) => [b.kind, b.line, b.ref])).toEqual([
      ["link", 2, "[x](./decisions/9999-no-such-adr.md#a)"],
    ]);
  });

  it("相対リンク: TS のコメントの中の、../ の数が合わないリンクは赤（PR #1118 で直した形）", () => {
    const ts =
      "/**\n * [ADR 0165](../../docs/decisions/0165-decay-activity-clock.md)\n */\nexport const x = /\\[a\\]\\(\\d{2}\\)/;\n";
    const broken = findBrokenReferences("packages/core/src/x.ts", commentTextOf(ts), REPO_ENV);
    expect(broken.map((b) => [b.kind, b.line])).toEqual([["link", 2]]);
  });

  it("ADR 番号: 存在しない番号は赤、在る番号は赤にならない", () => {
    const broken = findBrokenReferences(FILE, "ADR 0084 と ADR 9998 を見よ。\n", REPO_ENV);
    expect(broken.map((b) => [b.kind, b.line, b.ref])).toEqual([["adr", 1, "ADR 9998"]]);
  });

  it("<file>.md §N: 指す文書に無い節は赤、在る節は赤にならない", () => {
    const broken = findBrokenReferences(
      "AGENTS.md",
      "`docs/recall.md` §4 を見よ。\n`docs/recall.md` §99 を見よ。\n",
      REPO_ENV,
    );
    expect(broken.map((b) => [b.kind, b.line, b.ref])).toEqual([
      ["section", 2, "docs/recall.md §99"],
    ]);
  });

  it("赤の報告は、ファイル・行・参照・理由と、直し方（採用済み ADR は追記で訂正）を出す", () => {
    const broken = findBrokenReferences(FILE, "ADR 9998\n", REPO_ENV);
    const report = formatBrokenReferences(broken);
    expect(report).toContain("docs/recall.md:1 [adr] ADR 9998");
    expect(report).toContain("docs/decisions/9998-*.md が存在しない");
    expect(report).toContain("追記で訂正");
  });

  it("コードブロックの中のリンクは見ない（markdown）", () => {
    const md = "```\n[x](./no-such.md)\n```\n";
    expect(findBrokenReferences(FILE, maskMarkdownCodeFences(md), REPO_ENV)).toEqual([]);
  });
});

/** repo 直下の `.tmp/` は歩かない（並行に走る歯が作っては消すので、一覧に出たディレクトリが読む前に消えて ENOENT で落ちる）。 */
describe("walk は `.tmp/` を歩かない", () => {
  it("`.tmp/` の下は集めず、その外は集める", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doc-reference-tmp-"));
    try {
      mkdirSync(path.join(dir, ".tmp", "scratch"), { recursive: true });
      writeFileSync(path.join(dir, ".tmp", "scratch", "fixture.md"), "x\n");
      writeFileSync(path.join(dir, "outside.md"), "x\n");
      const files = walk(dir);
      expect(files.some((f) => f.split("/").includes(".tmp"))).toBe(false);
      expect(files.some((f) => f.endsWith("/outside.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
