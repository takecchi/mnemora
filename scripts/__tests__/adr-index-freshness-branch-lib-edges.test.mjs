import { describe, expect, it } from "vitest";
import {
  isPullRequestMergeRef,
  shouldEnforceAdrIndexFreshness,
} from "../adr-index-freshness-branch-lib.mjs";

/**
 * `adr-index-freshness-branch-lib.mjs`（ADR 0137・0192）の歯の足し（Issue #1815、09/16 マージ分の #398 の確かめ直し）。
 * 既存の `adr-index-freshness-branch-lib.test.mjs` が見ていなかった境界だけを足す。実装は変えない。
 * **これはクローン（miku）の判断で足した歯で、オーナーの判断ではない**（ADR 0220）。
 */

describe("isPullRequestMergeRef は `refs/pull/<数字>/merge` ちょうどだけを真にする", () => {
  it("末尾に何かが続く形は偽（`merge` で終わること）", () => {
    expect(isPullRequestMergeRef("refs/pull/5/merge/extra")).toBe(false);
    expect(isPullRequestMergeRef("refs/pull/5/merged")).toBe(false);
  });

  it("先頭に何かが付く形は偽（`refs/` で始まること）", () => {
    expect(isPullRequestMergeRef("refs/heads/refs/pull/5/merge")).toBe(false);
    expect(isPullRequestMergeRef("xrefs/pull/5/merge")).toBe(false);
  });

  it("PR 番号が空の形は偽（数字が1桁以上あること）", () => {
    expect(isPullRequestMergeRef("refs/pull//merge")).toBe(false);
  });

  it("PR 番号が数字でない形は偽", () => {
    expect(isPullRequestMergeRef("refs/pull/abc/merge")).toBe(false);
  });
});

describe("shouldEnforceAdrIndexFreshness の GITHUB_REF が無い側と、main でも PR でもない ref", () => {
  it("GITHUB_REF が空文字なら、無いものとして git のブランチ名で判定する", () => {
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "", gitBranch: "main" })).toBe(true);
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "", gitBranch: "feature" })).toBe(false);
  });

  it("手元の detached HEAD（ブランチ名が `HEAD`）は有効にしない", () => {
    expect(shouldEnforceAdrIndexFreshness({ gitBranch: "HEAD" })).toBe(false);
  });

  it("tag の ref は有効にしない（main の push と PR のマージプレビューだけ）", () => {
    expect(
      shouldEnforceAdrIndexFreshness({ githubRef: "refs/tags/v1.0.0", gitBranch: "main" }),
    ).toBe(false);
  });

  it("GITHUB_REF が別ブランチなら、git のブランチ名が main でも有効にしない（GITHUB_REF を信じる）", () => {
    expect(
      shouldEnforceAdrIndexFreshness({ githubRef: "refs/heads/other", gitBranch: "main" }),
    ).toBe(false);
  });
});
