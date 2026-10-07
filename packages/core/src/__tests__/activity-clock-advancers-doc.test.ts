import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");

function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/[^\n]*/g, blank);
}

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

function documentedAdvancers(): Set<string> {
  return new Set([...SOURCE.matchAll(/^\s*\*\s+- ADVANCER:\s+(\w+)/gm)].map((m) => m[1]!));
}

describe("活動時計を進める入口の一覧は、recall( の呼び出し元と一致する", () => {
  it("TSDoc の ADVANCER 一覧 = 呼び出しを囲む関数の集合", () => {
    const actual = callerFunctions();
    const documented = documentedAdvancers();
    expect(actual.size).toBeGreaterThan(0);
    expect(documented.size).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...actual].sort());
  });

  // `createRecall` に触れる口が `recall-runtime.ts` だけであることを縛る。時計を実際に進めるのは `MemoryStore.createRecall` なので、
  // `recall(` を通らずに呼ぶ口が増えると一覧が黙って欠ける。呼び出しの形ではなく、コメントを除いたコードにこの語が出るかで見る（別名で素通りさせない）。
  it("core の非テストのソースで createRecall に触れるのは recall-runtime.ts だけ（recall を通らずに時計を進める口が無い）", () => {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const files = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((p) => p.endsWith(".ts") && !p.split(/[\\/]/).includes("__tests__"))
      .map((p) => join(srcDir, p));
    const callers = new Set<string>();
    for (const file of files) {
      if (/\bcreateRecall\b/.test(stripComments(readFileSync(file, "utf8")))) {
        callers.add(relative(srcDir, file).split("\\").join("/"));
      }
    }
    // interface の宣言（`createRecall(ctx: Ctx, ...)`）も字句では同じ形なので、宣言のファイルは除く。
    callers.delete("interfaces/memory-store.ts");
    expect(files.length).toBeGreaterThan(0);
    expect([...callers]).toEqual(["recall-runtime.ts"]);
  });
});
