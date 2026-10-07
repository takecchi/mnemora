import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const runtimePath = join(repoRoot, "packages/core/src/runtime.ts");
const runtimeText = readFileSync(runtimePath, "utf8");

const readmePath = join(repoRoot, "README.md");
const visionPath = join(repoRoot, "docs/vision.md");
const architecturePath = join(repoRoot, "docs/architecture.md");

const LIVE_DOCS = [
  { label: "README.md", path: readmePath },
  { label: "docs/vision.md", path: visionPath },
  { label: "docs/architecture.md", path: architecturePath },
];

// 中核5動詞だけ literal で持つ。docs/vision.md が逐語で固定しており、main が動いても変わらない側だから。
const CORE_VERBS = ["observe", "recall", "consolidate", "reflect", "forget"];

/**
 * @returns {string}
 */
function extractRuntimeInterfaceBlock() {
  const startMarker = "export interface Runtime {";
  const startIdx = runtimeText.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      `runtime.ts に "${startMarker}" が見つからない——interface の宣言が変わった可能性がある`,
    );
  }
  const afterStart = runtimeText.slice(startIdx);
  const lines = afterStart.split("\n");
  let endLineIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^}/.test(lines[i])) {
      endLineIndex = i;
      break;
    }
  }
  if (endLineIndex === -1) {
    throw new Error("export interface Runtime の閉じる列0の '}' が見つからない");
  }
  return lines.slice(0, endLineIndex + 1).join("\n");
}

/**
 * @param {string} block
 * @returns {string[]}
 */
function extractMethodNamesFromBlock(block) {
  const methodRe = /^ {2}([A-Za-z][A-Za-z0-9_]*)\??\s*[(<]/gm;
  const names = [];
  let match;
  while ((match = methodRe.exec(block)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * @returns {string[]}
 */
function extractRuntimeMethodNames() {
  return extractMethodNamesFromBlock(extractRuntimeInterfaceBlock());
}

describe("Runtime のメソッドが3文書（README/vision/architecture）で名指しされている（Issue #518、ADR 0244）", () => {
  it("中核5動詞の literal が、一次資料 docs/vision.md に実在する", () => {
    const visionText = readFileSync(visionPath, "utf8");
    expect(visionText, "docs/vision.md に「中核の5動詞」という文字列が見つからない").toContain(
      "中核の5動詞",
    );
    for (const verb of CORE_VERBS) {
      expect(
        visionText,
        `docs/vision.md に CORE_VERBS の "${verb}" が \`${verb}\` の形で見つからない`,
      ).toContain(`\`${verb}\``);
    }
  });

  it("export interface Runtime から、メソッド名の集合を機械的に数え直せる", () => {
    const names = extractRuntimeMethodNames();

    for (const verb of CORE_VERBS) {
      expect(names, `抽出結果に中核動詞 "${verb}" が含まれない——抽出が壊れている`).toContain(verb);
    }

    // 総数をハードコードしない（main が動けば変わる）。下限だけ空回り防止として固定する。
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("陽性対照（Issue #926、ADR 0244「⛔ この歯が捕まえないもの」の4つ目）: 任意メソッド（`name?(`/`name?<`）も抽出する", () => {
    const block = [
      "export interface Sample {",
      "  required(ctx: Ctx): Promise<void>;",
      "  optional?(ctx: Ctx): Promise<void>;",
      "  optionalGeneric?<T>(ctx: Ctx, input: T): Promise<T>;",
      "}",
    ].join("\n");

    expect(extractMethodNamesFromBlock(block)).toEqual(["required", "optional", "optionalGeneric"]);
  });

  it("陰性対照（Issue #1804 の確かめ直し、クローン（miku）の判断）: 行頭2スペース以外・コメント内・メソッドでない行は抽出しない", () => {
    const block = [
      "export interface Sample {",
      "  /**",
      "   * nestedInComment(ctx) は doc コメントの中の文字列で、メソッドではない。",
      "   */",
      "  field: string;",
      "  real(",
      "    nestedParam(x: number): void,",
      "  ): Promise<void>;",
      "    indented4(ctx: Ctx): void;",
      "\tTabbed(ctx: Ctx): void;",
      "}",
    ].join("\n");

    expect(extractMethodNamesFromBlock(block)).toEqual(["real"]);
  });

  it("この歯が読んでいる3文書が、実在して空でない", () => {
    for (const doc of LIVE_DOCS) {
      const text = readFileSync(doc.path, "utf8");
      expect(
        text.length,
        `${doc.label} が1000文字未満——静かに空回りしている可能性がある`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });
});
