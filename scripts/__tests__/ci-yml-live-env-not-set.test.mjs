import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** ci.yml はこれらの名前をコメントの中で何度も説明しているので、コメントを取り除いてから見る。そのまま探すと必ず当たる。 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ciYml = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const conformanceDoc = readFileSync(join(repoRoot, "docs/conformance.md"), "utf8");

const LIVE_ENV =
  /\b(MNEMORA_LIVE_OPENAI|MNEMORA_LIVE_ANTHROPIC|MNEMORA_LIVE_LOCAL_EMBEDDING|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/;

function withoutComments(yaml) {
  return yaml
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line.replace(/\s#.*$/, "")))
    .join("\n");
}

describe("docs/conformance.md §3: ci.yml は live の歯を開く env を設定しない", () => {
  it("陽性対照: 文書はその約束をしており、ci.yml はそれらの名前をコメントでは挙げている", () => {
    expect(conformanceDoc).toContain(
      "`.github/workflows/ci.yml` に、この4つの env は設定値として1つも無い",
    );
    expect(LIVE_ENV.test(ciYml)).toBe(true);
  });

  it("コメントを除いた ci.yml に、4つの env（とその鍵）の名前が1つも無い", () => {
    const hits = withoutComments(ciYml)
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => LIVE_ENV.test(text));
    expect(hits).toEqual([]);
  });
});
