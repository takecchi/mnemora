import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `runtime.ts` の TSDoc（行頭の印 `ADVANCER: 名前`）が挙げる「活動時計を進める入口」の一覧が、
 * ソースの `recall(` / `runRecall(` の呼び出しを囲む関数の集合と一致することを縛る（ADR 0394 の訂正追記）。
 * 期待値は実行時にソースから取る。件数も名前もここには書かない。
 * `sweepArchive` のように本体に呼び出しが無い関数は、集合に入らないので、一覧に載ると赤になる。
 */

const SOURCE = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");

/** 改行は保ったまま、ブロックコメントと行コメントを空白にする。 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/[^\n]*/g, blank);
}

/** コメントを除いたソースで、`recall(`/`runRecall(` の呼び出しを囲む関数名の集合。 */
function callerFunctions(): Set<string> {
  const lines = stripComments(SOURCE).split("\n");
  const callRe = /(?<![\w.])(?:recall|runRecall)\(/g;
  const fnRe = /^ {0,2}(?:export )?(?:async )?function\s+(\w+)/;
  const found = new Set<string>();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(callRe)) {
      const before = line.slice(0, m.index);
      // 定義（`function recall(`）と、interface のメンバ宣言（行頭の `recall(`）は呼び出しではない。
      if (/function\s+$/.test(before) || before.trim() === "") continue;
      for (let j = i; j >= 0; j--) {
        const f = fnRe.exec(lines[j]!);
        if (f) {
          found.add(f[1]!);
          break;
        }
      }
    }
  });
  return found;
}

/** TSDoc の `- ADVANCER: 名前` の行から読んだ集合。 */
function documentedAdvancers(): Set<string> {
  return new Set([...SOURCE.matchAll(/^\s*\*\s+- ADVANCER:\s+(\w+)/gm)].map((m) => m[1]!));
}

describe("活動時計を進める入口の一覧は、recall( の呼び出し元と一致する", () => {
  it("TSDoc の ADVANCER 一覧 = 呼び出しを囲む関数の集合", () => {
    const actual = callerFunctions();
    const documented = documentedAdvancers();
    // 健全性: 検査が空振りしていないこと。
    expect(actual.size).toBeGreaterThan(0);
    expect(documented.size).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...actual].sort());
  });
});
