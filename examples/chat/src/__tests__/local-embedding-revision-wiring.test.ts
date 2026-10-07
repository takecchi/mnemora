import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${srcDir}/${entry.name}`);
}

function findLocalEmbeddingProviderCalls(source: string): string[] {
  const CALL_RE = /new LocalEmbeddingProvider\(([\s\S]*?)\);/g;
  const calls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CALL_RE.exec(source)) !== null) {
    // `?? ""` は noUncheckedIndexedAccess を満たすためだけ。
    calls.push(match[1] ?? "");
  }
  return calls;
}

describe("examples/chat: new LocalEmbeddingProvider(...) はすべて固定した revision を渡す（Issue #597 案(a)、ADR 0253 追記5）", () => {
  const callsByFile = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const calls = findLocalEmbeddingProviderCalls(readFileSync(file, "utf8"));
    if (calls.length > 0) {
      callsByFile.set(file, calls);
    }
  }

  it("⚠ 陰性対照: 呼び出しが1件も見つからない、という壊れ方をしていない（正規表現が退化していない）", () => {
    const totalCalls = [...callsByFile.values()].reduce((sum, calls) => sum + calls.length, 0);
    expect(totalCalls).toBeGreaterThan(0);
  });

  it("呼び出しが見つかったファイルは、providers.ts と embedding-fingerprint.ts のちょうど2つである", () => {
    const fileNames = [...callsByFile.keys()].map((f) => f.split("/").pop() ?? f).sort();
    expect(fileNames).toEqual(["embedding-fingerprint.ts", "providers.ts"]);
  });

  it("すべての呼び出しが revision: localEmbeddingPinnedRevision() を渡している", () => {
    for (const [file, calls] of callsByFile) {
      for (const call of calls) {
        expect(call, `${file} の呼び出し: ${call}`).toContain(
          "revision: localEmbeddingPinnedRevision()",
        );
      }
    }
  });
});
