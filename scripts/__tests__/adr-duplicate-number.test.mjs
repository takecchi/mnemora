import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAdrEntries } from "../generate-adr-index-lib.mjs";

/** `adr-index-freshness.test.mjs` に足さない。あちらは `main` でしか走らず、PR ブランチで重複を止められない。 */

const decisionsDir = fileURLToPath(new URL("../../docs/decisions", import.meta.url));

function loadAdrFiles() {
  return readdirSync(decisionsDir)
    .filter((filename) => filename !== "README.md")
    .map((filename) => ({
      filename,
      content: readFileSync(`${decisionsDir}/${filename}`, "utf8"),
    }));
}

describe("docs/decisions/*.md に重複番号が無いか（PR でも無条件に走る）", () => {
  it("同じ4桁番号を名乗るファイルが2本以上無い", () => {
    const files = loadAdrFiles();
    expect(() => buildAdrEntries(files)).not.toThrow();
  });

  it("空振り防止: ADR ファイルが1件以上ある", () => {
    const files = loadAdrFiles();
    const entries = buildAdrEntries(files);
    expect(entries.length).toBeGreaterThan(0);
  });
});
