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

/**
 * 生きた文書の中の参照が、指す先に届くことの門（PR #1118 の提案を、クローン miku が門にすると
 * 判断した）。何を見て何を見ないかは `scripts/doc-reference-lib.mjs` の doc コメントに在る
 * （ここには写さない）。
 *
 * 期待値（リンク先のファイル・ADR のファイル・見出しの番号）は、どれも実行時に repo から取る。
 * 数や一覧を焼き込まないので、期待値の側は腐らない。
 *
 * 陽性対照: 3つの形それぞれで、腐った参照を1つ入れた入力が赤になることを、同じ `env` で
 * 確かめる（検査器が黙って何も見なくなる回帰を捕まえるため）。
 */

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

/** 生きた文書: `docs/**`（`docs/decisions/` を除く）・各 `README.md`・`AGENTS.md`・`packages/*\/src` の TS。 */
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
    // TS のコメントの中の ADR へのリンクが、実際に検査の入力に入っている。
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
    // ADR 0165 は実在するので赤は link の1件だけ。正規表現の中の `[a](\\d{2})` は拾わない。
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

/**
 * repo 直下の `.tmp/`（`.gitignore` 済みの作業場所）は歩かない。
 *
 * 【実測 2026-09-28】`no-unhandled-errors.test.mjs` は root の vitest の中で `.tmp/no-unhandled-errors-*` に
 * fixture を作っては消す。上の `walk(REPO_ROOT)` は収集の段で repo 全体を歩くので、並行に走ると、一覧に出た
 * ディレクトリが読む前に消え、`ENOENT: … scandir '…/.tmp/…'` でファイルごと落ちうる（`.tmp/` の下で作っては
 * 消しながらこの歯を8回走らせると5回落ちた）。`adr-citation.test.mjs` と同じ直し方。
 */
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
