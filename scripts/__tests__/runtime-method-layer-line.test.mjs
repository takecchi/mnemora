import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`packages/core/src/runtime.ts` の `export interface Runtime` の各メソッドの、直前の
 * JSDoc（`/** ... *\/`）に、`層: <値>` の行がちょうど1行あること**（Issue #605、ADR 0633）。
 * 値は `中核` / `保守操作` / `是正・取り消し` / `説明` / `未分類` の5種のどれか1つ。
 * 「どのメソッドがどの層か」の正本はこの行であり、3文書（README.md / docs/vision.md /
 * docs/architecture.md）はメソッド名を列挙しない。
 *
 * 行の形は、1行ごとに次の正規表現へ「ちょうど当たる」こと:
 * `^\s*\*\s層: (中核|保守操作|是正・取り消し|説明|未分類)\s*$`
 * ⟹ 全角コロン `層：`・値が5種以外・値の後ろに文が続く行（`層: 中核 です`）は「層の行」と数えず、
 *    `層` + コロンで始まる崩れた行が1行でもあれば「形が違う」で赤（正しい行が隣に在っても赤）。
 *    `Layer:` のような別の語は層の行のつもりとも見なさない（その行しか無ければ「無い」で赤）。
 *
 * ## 捕まえるもの
 * - 層の行が無い（JSDoc が無い、JSDoc に層の行が無い、別の語で書いた）
 * - 層の行の形が違う（`層` + 半角/全角コロンで始まるが、正しい形に当たらない行が在る）
 * - 層の行が2行以上ある（同じ JSDoc に2行）
 * - 別のメソッドの JSDoc に在る層の行は、当のメソッドの分には数えない（メソッドごとに見る）
 * - JSDoc の外の行コメント（`// 層: 中核`）は数えない
 *
 * ## 捕まえないもの（射程外）
 * ⛔ **層の値が意味として正しいかは見ない。**`applyCorrection` を `中核` と書いても、
 *    値が5種のどれかなら緑である。意味の判定であり、機械には決まらない
 *    （`未分類` はその判断が割れている・まだ置かれていないものの置き場）。
 * ⛔ **`export interface Runtime` 以外は見ない。**実装（`createRuntime`）側・他の interface
 *    （`MemoryStore` 等）には層の行を要求しない。
 * ⛔ **メソッド数は固定しない**（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。
 *    下限（空回り防止）だけを置く。
 * ⛔ **3文書がメソッド名を列挙していないことは見ない。**（旧 ADR 0244 の it4 は外した。
 *    メソッドが文書のどこにも出ない穴の役目は、この歯が「各メソッドが層の行を持つ」で引き継ぐ。）
 *
 * ## メソッド名の抽出
 * `runtime-method-doc-correspondence.test.mjs`（ADR 0244）と同じ規則: `export interface Runtime {`
 * から列0の `}` までを切り、行頭2スペースの `name(` / `name?(` / `name<` / `name?<` を拾う。
 * 直前の JSDoc は「宣言の1行上が `*\/` で終わる」ものを指し、そこから `/**` まで遡る。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimeText = readFileSync(join(repoRoot, "packages/core/src/runtime.ts"), "utf8");

const LAYER_LINE_RE = /^\s*\*\s層: (中核|保守操作|是正・取り消し|説明|未分類)\s*$/;
// 「層の行のつもりの行」: JSDoc の行頭（`*` の後）が `層` + 半角/全角コロンで始まるもの。
// ⛔ `Layer:` のような別の語は拾わない（その行しか無ければ「層の行が無い」で赤になる）。
const LAYER_LIKE_RE = /^\s*\*\s*層\s*[:：]/;
const METHOD_RE =/^ {2}([A-Za-z][A-Za-z0-9_]*)\??\s*[(<]/;

/** @param {string} text */
function extractInterfaceBlock(text, startMarker = "export interface Runtime {") {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`"${startMarker}" が見つからない——interface の宣言が変わった可能性がある`);
  }
  const lines = text.slice(startIdx).split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^}/.test(lines[i])) return lines.slice(0, i + 1).join("\n");
  }
  throw new Error("interface の閉じる列0の '}' が見つからない");
}

/**
 * ⭐ 純関数。interface のブロック文字列から、メソッドごとに層の行の問題を返す。
 * 問題が無ければ problems は空。
 *
 * @param {string} block
 * @returns {{ method: string, layerLines: string[], problem: string | null }[]}
 */
export function checkLayerLines(block) {
  const lines = block.split("\n");
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const m = METHOD_RE.exec(lines[i]);
    if (!m) continue;
    const method = m[1];
    // 直前の JSDoc: 1行上が `*/` で終わること。そこから `/**` まで遡る。
    if (i === 0 || !/\*\/\s*$/.test(lines[i - 1])) {
      results.push({ method, layerLines: [], problem: "直前に JSDoc が無い" });
      continue;
    }
    let start = i - 1;
    while (start >= 0 && !/^\s*\/\*\*/.test(lines[start])) start--;
    if (start < 0) {
      results.push({ method, layerLines: [], problem: "直前の JSDoc の開始 `/**` が見つからない" });
      continue;
    }
    const doc = lines.slice(start, i);
    const layerLines = doc.filter((l) => LAYER_LINE_RE.test(l));
    // 正しい形の行の隣に崩れた形の行（`層：…`・`層: 不明`）があると、正しい1行だけを数えて
    // 通ってしまう。崩れた形も「層の行のつもりの行」として拾い、正しい形でなければ赤にする。
    const malformed = doc.filter((l) => LAYER_LIKE_RE.test(l) && !LAYER_LINE_RE.test(l));
    let problem = null;
    if (malformed.length > 0) problem = `層の行の形が違う: ${malformed.map((l) => l.trim()).join(" / ")}`;
    else if (layerLines.length === 0) problem = "層の行が無い";
    else if (layerLines.length > 1) problem = `層の行が${layerLines.length}行ある`;
    results.push({ method, layerLines, problem });
  }
  return results;
}

/** @param {ReturnType<typeof checkLayerLines>} results */
function problemsOf(results) {
  return results.filter((r) => r.problem !== null).map((r) => `${r.method}: ${r.problem}`);
}

const FIX = "層: 中核";

describe("Runtime の各メソッドの直前の JSDoc に `層:` の行がちょうど1行ある（Issue #605、ADR 0633）", () => {
  it("本体: export interface Runtime の全メソッドが、層の行をちょうど1行持つ", () => {
    const results = checkLayerLines(extractInterfaceBlock(runtimeText));

    // 空回り防止: 抽出が生きていること（総数は固定しない。下限だけ）
    expect(results.length).toBeGreaterThanOrEqual(10);
    for (const verb of ["observe", "recall", "consolidate", "reflect", "forget"]) {
      expect(
        results.map((r) => r.method),
        `抽出結果に中核動詞 "${verb}" が無い——抽出が壊れている`,
      ).toContain(verb);
    }

    const bad = results.filter((r) => r.problem !== null);
    if (bad.length > 0) {
      expect.fail(
        [
          "Runtime のメソッドの直前の JSDoc に、層の行が正しく書かれていない:",
          "",
          ...bad.map((r) => `  ${r.method}: ${r.problem}`),
          "",
          "⟹ どうすればよいか:",
          "  packages/core/src/runtime.ts の該当メソッドの JSDoc の `/**` の直後の行に、",
          "    `   * 層: <値>`",
          "  を1行だけ書く。値は 中核 / 保守操作 / 是正・取り消し / 説明 / 未分類 のどれか。",
          "  全角コロン `層：`・`Layer:`・値の後ろに文を続けた行は数えない。",
          "  分類が決まらないなら `未分類`（判断が割れているもの。あとで1本ずつ決める）。",
          "  ⛔ 他のメソッドの JSDoc の層の行を流用しない。1メソッドにつき1行。",
        ].join("\n"),
      );
    }
  });

  it("陽性対照: 正しい形（5種の値それぞれ・`?` 付き・複数行宣言）は通る", () => {
    const values = ["中核", "保守操作", "是正・取り消し", "説明", "未分類"];
    const body = values
      .map(
        (v, i) =>
          `  /**\n   * 層: ${v}\n   * 概要 ${i}\n   */\n  m${i}${i === 1 ? "?" : ""}(\n    ctx: Ctx,\n  ): Promise<void>;`,
      )
      .join("\n");
    const block = `export interface Runtime {\n${body}\n}`;
    const results = checkLayerLines(block);
    expect(results.map((r) => r.method)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(problemsOf(results)).toEqual([]);
  });

  it("陰性対照: 層の行が無い・JSDoc が無い・2行ある、は赤", () => {
    const block = [
      "export interface Runtime {",
      "  /**",
      "   * 概要だけ",
      "   */",
      "  none(ctx: Ctx): Promise<void>;",
      "  bare(ctx: Ctx): Promise<void>;",
      "  /**",
      `   * ${FIX}`,
      `   * ${FIX}`,
      "   */",
      "  twice(ctx: Ctx): Promise<void>;",
      "}",
    ].join("\n");
    expect(problemsOf(checkLayerLines(block))).toEqual([
      "none: 層の行が無い",
      "bare: 直前に JSDoc が無い",
      "twice: 層の行が2行ある",
    ]);
  });

  it("陰性対照 (a): 別メソッドの JSDoc に層の行があっても、当のメソッドに無ければ赤（interface 全体を見る実装を落とす）", () => {
    const block = [
      "export interface Runtime {",
      "  /**",
      `   * ${FIX}`,
      "   */",
      "  has(ctx: Ctx): Promise<void>;",
      "  /**",
      "   * 概要だけ",
      "   */",
      "  lacks(ctx: Ctx): Promise<void>;",
      "}",
    ].join("\n");
    expect(problemsOf(checkLayerLines(block))).toEqual(["lacks: 層の行が無い"]);
  });

  it("陰性対照 (b): 全角コロン・値が5種以外・値の後ろに文が続く行は、層の行と数えない（緩い正規表現を落とす）", () => {
    const variants = [
      "層：中核", // 全角コロン
      "層： 中核", // 全角コロン+空白
      "層: 不明", // 値が5種以外
      "層: 中核 です", // 値の後ろに文
      "層: 中核・保守操作", // 値の連結
      "層:中核", // 半角コロンの後ろに空白が無い
    ];
    const blockOf = (/** @type {string[]} */ docLines) =>
      [
        "export interface Runtime {",
        "  /**",
        ...docLines.map((l) => `   * ${l}`),
        "   */",
        "  m(ctx: Ctx): Promise<void>;",
        "}",
      ].join("\n");
    for (const v of variants) {
      expect(problemsOf(checkLayerLines(blockOf([v]))), `「${v}」が層の行として通ってしまった`).toEqual([
        `m: 層の行の形が違う: * ${v}`,
      ]);
      // 正しい行が隣に在っても、崩れた行は赤（正しい1行だけを数える実装を落とす）
      expect(
        problemsOf(checkLayerLines(blockOf([FIX, v]))),
        `正しい行の隣の「${v}」が見逃された`,
      ).toEqual([`m: 層の行の形が違う: * ${v}`]);
    }
    // 別の語は層の行のつもりとも見なさない（その行しか無ければ「無い」）
    expect(problemsOf(checkLayerLines(blockOf(["Layer: 中核"])))).toEqual(["m: 層の行が無い"]);
  });

  it("陰性対照 (c): JSDoc の外の行コメント `// 層: 中核` は数えない", () => {
    const above = [
      "export interface Runtime {",
      `  // ${FIX}`,
      "  /**",
      "   * 概要だけ",
      "   */",
      "  m(ctx: Ctx): Promise<void>;",
      "}",
    ].join("\n");
    expect(problemsOf(checkLayerLines(above))).toEqual(["m: 層の行が無い"]);

    const between = [
      "export interface Runtime {",
      "  /**",
      "   * 概要だけ",
      "   */",
      `  // ${FIX}`,
      "  m(ctx: Ctx): Promise<void>;",
      "}",
    ].join("\n");
    expect(problemsOf(checkLayerLines(between))).toEqual(["m: 直前に JSDoc が無い"]);
  });
});
