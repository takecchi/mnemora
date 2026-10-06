import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）で、PR #1491 の変異試験が**すり抜けた**
 * 「testkit の `peerDependencies` から `zod` を外す」を塞ぐ歯。担当はクローン（miku）の判断で進めている
 * 作業であり、オーナーの判断ではない。
 *
 * testkit の公開 d.ts は `zod` の型を使う（core の公開の型経由）。`peerDependencies` に `zod` が無いと、
 * pnpm の `hoist=false` の利用者は `TS2307`（zod が見つからない）で型検査に落ちる。既定の hoist では
 * 偶然解決して気づけない。PR #1491 の確かめ方は pack して一時プロジェクトで `tsc` に掛ける手作業で、
 * 歯として残っていなかった（scripts の pack 検査も、この manifest の zod は見ていない）。
 * ここでは manifest を直接見る（pack・install はしない。偽陽性は manifest の書き方を変えたときだけ）。
 *
 * 範囲は core の `dependencies.zod` と同じにする（PR #1491 の約束。2つの版の zod が同居しないように）。
 */

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
    // 前提（対照）: core 側が zod の範囲を持っている。
    expect(core.dependencies?.zod).toBeDefined();
    expect(testkit.peerDependencies?.zod).toBe(core.dependencies?.zod);
  });
});
