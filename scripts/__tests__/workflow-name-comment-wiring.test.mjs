import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeWorkflowNames } from "../workflow-name-comment-lib.mjs";

// YAML パーサの依存は足さず、自前のコメント規則（workflow-name-comment-lib.mjs）で読む。
// 扱えない形（unhandled）は安全側（緑）へ倒さず、赤くする。

const workflowsDir = fileURLToPath(new URL("../../.github/workflows", import.meta.url));

/**
 * @returns {{ fileName: string, text: string }[]}
 */
function readWorkflowFiles() {
  const fileNames = readdirSync(workflowsDir).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  expect(
    fileNames.length,
    ".github/workflows/ に *.yml/*.yaml が1つも無い——ディレクトリの場所か拡張子が変わった。",
  ).toBeGreaterThan(0);
  return fileNames.map((fileName) => ({
    fileName,
    text: readFileSync(join(workflowsDir, fileName), "utf8"),
  }));
}

describe(".github/workflows/** の name: が YAML のコメントに食われて切れていないこと", () => {
  const files = readWorkflowFiles();

  it("対象ファイルが2本(ci.yml / publish.yml)より減っていない(門の対象が痩せていないこと)", () => {
    // toEqual で完全一致にしない（新しい workflow を足すたびに無関係な理由で赤くなる）。
    // arrayContaining で「減っていないこと」だけを見る。
    expect(files.map((f) => f.fileName)).toEqual(expect.arrayContaining(["ci.yml", "publish.yml"]));
  });

  for (const { fileName, text } of files) {
    describe(fileName, () => {
      const results = analyzeWorkflowNames(text, fileName);

      it("name: 宣言が1個以上見つかる(抽出そのものが壊れていないこと)", () => {
        expect(
          results.length,
          `${fileName} から name: 宣言が1つも取れなかった——findNameDeclarations の` +
            "正規表現が壊れたか、ファイルの形が変わった。",
        ).toBeGreaterThan(0);
      });

      it("truncated(黙って切れる)判定が1件も無い", () => {
        const truncated = results.filter((r) => r.status === "truncated");
        expect(
          truncated,
          truncated
            .map(
              (r) =>
                `${fileName}:${r.lineNumber} — 引用符無しの値が半角空白付きの # で切れている。` +
                `残る部分: ${JSON.stringify(r.kept)} / 生の行: ${r.rawLine}`,
            )
            .join("\n"),
        ).toHaveLength(0);
      });

      it("🔴 unhandled(この歯が自信を持てない形)が1件も無い", () => {
        const unhandled = results.filter((r) => r.status === "unhandled");
        expect(
          unhandled,
          unhandled
            .map(
              (r) =>
                `${fileName}:${r.lineNumber} — この歯が扱えない形の name: に出会った` +
                `(reason: ${r.reason})。安全と決めつけず、workflow-name-comment-lib.mjs に` +
                `この形の判定を足すこと。生の行: ${r.rawLine}`,
            )
            .join("\n"),
        ).toHaveLength(0);
      });
    });
  }

  it("⭐ 対照: ci.yml:518 型(全角括弧の直後に #)の名前が、誤って truncated 扱いされていない", () => {
    // job id で場所を探す（表示名の文言で探すと、文言の書き換えで対照の場所を見失う）。
    const ciYml = files.find((f) => f.fileName === "ci.yml");
    expect(ciYml, "ci.yml が読めていない").toBeDefined();
    const jobIdLine = ciYml.text.split("\n").findIndex((line) => line === "  identifier-probes:");
    expect(
      jobIdLine,
      "ci.yml に `  identifier-probes:` ジョブが無い——対照事例そのものが無くなっている。" +
        "ジョブ ID が変わったなら、この対照の探し方を直すこと。",
    ).toBeGreaterThan(-1);
    const results = analyzeWorkflowNames(ciYml.text, "ci.yml");
    const jobNameDecl = results.find(
      (r) => !r.isStep && r.indent === 4 && r.lineNumber > jobIdLine + 1,
    );
    expect(
      jobNameDecl,
      "identifier-probes ジョブの直後に job 直下の name: が見当たらない",
    ).toBeDefined();
    expect(jobNameDecl?.value).toContain("（#106）");
    expect(jobNameDecl?.status).toBe("safe");
  });
});
