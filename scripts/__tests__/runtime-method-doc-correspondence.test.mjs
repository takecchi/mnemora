import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **README.md / docs/vision.md / docs/architecture.md の3文書が、中核5動詞の名前を持っていること
 * （一次資料 docs/vision.md「中核の5動詞」に逐語で在る）と、`Runtime`
 * （`packages/core/src/runtime.ts` の `export interface Runtime`）のメソッド名を機械的に数え直せること**
 * （Issue #518、ADR 0244）。
 *
 * ## ⚠ ADR 0633 で、この歯の役目の一部を新しい歯へ移した（2026-10）
 *
 * ADR 0244 決定1は「3文書が、中核以外の全メソッド名を `name` の形で並べる」ことを歯で縛っていた
 * （旧 it 4）。ADR 0633 は、**どのメソッドがどの層かの正本を `runtime.ts` の各メソッドの doc コメントの
 * `層:` 行に移し、3文書からメソッド名の列挙を外した**。⟹ **旧 it 4 は外した**
 * （残すと、列挙を外した文書に対して永遠に赤になる）。
 *
 * **旧 it 4 の役目——「`Runtime` に口が増えたのに、どこにも名指しされないまま `main` へ入る穴」——は、
 * `runtime-method-layer-line.test.mjs` が引き継ぐ**: 新しい口は、層の行を持たなければ赤になる
 * （層の行は `未分類` でもよい）。**ここに残っているのは it 1（中核5動詞の literal の実在）・
 * 抽出の it（陽性対照を含む）・3文書が空でないことの検査である。**
 *
 * 🔑 **なぜ「件数」ではなく「名前の集合」を数え直すか**: Issue #518 が見つけた壊れ方は
 * 「10個」という数字が古くなったことだった。⟹ 件数は焼き込まず、`Runtime` から毎回数え直す。
 *
 * ## 正典の導出は、コードのパースであってプローズのパースではない
 *
 * `packages/core/src/runtime.ts` を読み、`export interface Runtime {` の行から
 * 列0の `}` までを切り出し、その範囲から行頭2スペースのメソッド宣言
 * （`/^ {2}([A-Za-z][A-Za-z0-9_]*)\??\s*[(<]/`——`?` は TypeScript の任意メソッド構文
 * `name?(`/`name?<` も拾うための追加、2026-09-26、Issue #926）を正規表現で拾う。
 * 新しい歯 `runtime-method-layer-line.test.mjs` も同じ規則でメソッド名を拾う。
 *
 * ## literal で持ってよい唯一のもの: 中核5動詞
 *
 * `CORE_VERBS` だけは literal で持つ。正典（`docs/vision.md`「外から見える API: 中核の5動詞」）
 * が逐語で「ここは増やさない」と固定しており、`main` が動いても変わらない側だからである
 * （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」の「⭐ 線は『main が動くと変わるか』
 * である」）。**literal を持つなら、その literal が一次資料に実在することを別の `it` で検査する**
 * （`it` 1。ADR 0212 から継いだ部分）。
 *
 * ## この歯が縛らないこと
 *
 * ⛔ **層の分類は縛らない**（意味の判定。層の行の有無は `runtime-method-layer-line.test.mjs`）。
 * ⛔ **総数はハードコードしない。**`it` 2 は下限（`R.length >= 10`）だけを固定する空回り防止である。
 *
 * ## 確かめていないこと
 *
 * - `Runtime` 以外の interface（`MemoryStore` 等）に同じ形の焼き込みが在るかは掃いていない。
 */

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

// ⭐ 中核5動詞だけは literal で持つ。正典（docs/vision.md「外から見える API: 中核の5動詞」）が
//    逐語で「ここは増やさない」と固定しており、main が動いても変わらない側だからである
//    （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」の「⭐ 線は『main が動くと変わるか』である」）。
const CORE_VERBS = ["observe", "recall", "consolidate", "reflect", "forget"];

/**
 * `export interface Runtime { ... }` を、列0の `}` までで切り出す。
 *
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
 * 行頭2スペースのメソッド宣言（必須・任意どちらも）の名前を、渡されたブロック文字列から
 * 機械的に抽出する。⭐ これはコードのパースであってプローズのパースではない。
 *
 * ⚠ **2026-09-26 追記（Issue #926、ADR 0244「⛔ この歯が捕まえないもの」の4つ目）**:
 * 正規表現は名前の直後に任意の `?`（TypeScript の任意メソッド構文 `name?(` / `name?<`）を
 * 許す。`?` を許さない版では `resolveOrphanedContested?(...)`（Issue #825、`7ab8948`）が
 * 抽出結果から丸ごと落ち、下の「本体」の `it` がこの名前を3文書に対して一度も検査しない
 * まま歯全体が緑になっていた——変異試験で実際に確認した（このファイルの
 * 「陽性対照（Issue #926）」の `it` が、その回帰を固定する）。
 *
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
 * `export interface Runtime` のブロックから、メソッド名の集合を抽出する。
 *
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

    // 陽性対照: 抽出が生きていることの証拠。CORE_VERBS を全部含まなければ、
    // 正規表現かマーカー文字列が壊れている。
    for (const verb of CORE_VERBS) {
      expect(names, `抽出結果に中核動詞 "${verb}" が含まれない——抽出が壊れている`).toContain(verb);
    }

    // ⛔ 総数をハードコードしない——main が動けば変わる側である
    // （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。下限だけを空回り防止として固定する。
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("陽性対照（Issue #926、ADR 0244「⛔ この歯が捕まえないもの」の4つ目）: 任意メソッド（`name?(`/`name?<`）も抽出する", () => {
    // fixture: 実在の Runtime を経由せず、抽出そのものが `?` を通すことを固定で示す。
    // ⚠ この it が赤くなった場合、`resolveOrphanedContested?(...)`（Issue #825）のような
    // 任意メソッドが、下の「本体」の it の検査対象（target）から丸ごと落ちる——
    // 3文書での名指しが一度も検査されないまま歯全体が緑になる、という取りこぼしが
    // 再発している。
    const block = [
      "export interface Sample {",
      "  required(ctx: Ctx): Promise<void>;",
      "  optional?(ctx: Ctx): Promise<void>;",
      "  optionalGeneric?<T>(ctx: Ctx, input: T): Promise<T>;",
      "}",
    ].join("\n");

    expect(extractMethodNamesFromBlock(block)).toEqual(["required", "optional", "optionalGeneric"]);
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
