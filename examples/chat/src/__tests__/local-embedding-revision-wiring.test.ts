import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `new LocalEmbeddingProvider(...)` を作る examples/chat 側のすべての箇所が、
 * 固定した revision（`localEmbeddingPinnedRevision()`、Issue #597 案(a)）を渡している
 * ことを固定する歯（ADR 0253 追記5）。
 *
 * 【背景】CI run 35953212055 の後の調査で、`examples/chat/src/embedding-fingerprint.ts`
 * が revision を渡さずに `LocalEmbeddingProvider` を作っていたことが発覚した——
 * `examples/chat/src/providers.ts` は既に渡していたので、同じ `example-chat` ジョブの
 * 中で「main を読む経路」と「固定 revision を読む経路」が両方走り、
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` が指すキャッシュディレクトリに両方の配置
 * （フラット・revision サブディレクトリ）が同居していた（門の「一致4本・素性不明4本」
 * の一因）。**クローンの決定は「使う側はすべて固定する」であり、この経路も
 * 「使う側」である。**
 *
 * ⭐ **この歯は特定のファイル名を決め打ちしない。** `examples/chat/src/*.ts`
 * （`__tests__` を除く、直下のファイルだけ）を機械的に全部見て、
 * `new LocalEmbeddingProvider(` の呼び出しをすべて拾う——将来3つ目の呼び出しが
 * 増えても、この歯が revision の有無を見る。⛔ **呼び出しがちょうど2箇所であること
 * 自体も assert する**（見つかった箇所が増減したら、この歯を書き換えて対象を
 * 更新すること——見落とさないための陽性対照）。
 */

const srcDir = fileURLToPath(new URL("..", import.meta.url));

/** `examples/chat/src` 直下の `.ts` ファイル（`__tests__` は `readdirSync` の対象外）。 */
function sourceFiles(): string[] {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${srcDir}/${entry.name}`);
}

/**
 * ソースから `new LocalEmbeddingProvider(...)` の呼び出しの引数部分を全部拾う。
 *
 * ⚠ **非貪欲マッチ（`[\s\S]*?`）で、最初に現れる `);` までを1呼び出し分とする。**
 * 実際の呼び出しは `new LocalEmbeddingProvider({ ...options... });` という
 * オブジェクトリテラル1つだけを引数に取る形なので、引数の中に `);` という並びが
 * 現れることはない（関数呼び出しをオプション値として渡していないため）。
 */
function findLocalEmbeddingProviderCalls(source: string): string[] {
  const CALL_RE = /new LocalEmbeddingProvider\(([\s\S]*?)\);/g;
  const calls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CALL_RE.exec(source)) !== null) {
    // ⚠ グループ自体は常に埋まる（`[\s\S]*?` は空文字にもマッチしうるが、group が
    // 存在しないことはない）——`?? ""` は `noUncheckedIndexedAccess` を満たすためだけ。
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
    // 3つ目が増えたら、この歯を書き換えて対象に含めること（見落とさない）。
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
