import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** testkit の公開 d.ts は `zod` の型を使うので、`peerDependencies` に無いと pnpm の `hoist=false` の利用者は `TS2307` で型検査に落ちる（既定の hoist では偶然解決して気づけない）。manifest を直接見る（pack・install はしない）。範囲は core の `dependencies.zod` と同じにする（2つの版の zod が同居しないように）。 */

function readManifest(relative: string): {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
}

const testkit = readManifest("../../package.json");
const core = readManifest("../../../core/package.json");

describe("@mnemora/testkit の package.json: zod は peerDependencies に在り、core と同じ範囲である（Issue #1734 / PR #1491 のすり抜け）", () => {
  it("peerDependencies に zod が在る（dependencies には無い。同梱しない）", () => {
    expect(testkit.peerDependencies?.zod).toBeDefined();
    expect(testkit.dependencies?.zod).toBeUndefined();
  });

  it("その範囲は core の dependencies.zod と同じ", () => {
    expect(core.dependencies?.zod).toBeDefined();
    expect(testkit.peerDependencies?.zod).toBe(core.dependencies?.zod);
  });
});
