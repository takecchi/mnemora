import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXACT_PINNED_DEPENDENCY_EXEMPTIONS,
  findExactPinnedDependencyViolations,
} from "../publish-pack-checks.mjs";

// 範囲指定へ緩めても publish 梱包の門は通る（門は「固定してはいけない」側しか見ない）。bullmq を固定したままであることは、ここで直接見る。
const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../packages/bullmq/package.json", import.meta.url)),
    "utf8",
  ),
);

describe("@mnemora/bullmq の実行時依存の固定", () => {
  it("bullmq は完全固定のまま（メジャー版の違う Job Scheduler API が黙って入らない）", () => {
    expect(manifest.dependencies.bullmq).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("免除の一覧に載るのは bullmq だけで、ほかの実行時依存（ioredis）は免除なしで範囲指定を保つ", () => {
    expect(EXACT_PINNED_DEPENDENCY_EXEMPTIONS["@mnemora/bullmq"]).toEqual(["bullmq"]);
    const violations = findExactPinnedDependencyViolations(manifest, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("dependencies.bullmq");
  });
});
