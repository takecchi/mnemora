import { describe, expect, it } from "vitest";
import { distTagFor, versionFromTag } from "../release-version.mjs";

describe("versionFromTag（ADR 0070）", () => {
  it("v0.1.2 から 0.1.2 を取り出す", () => {
    expect(versionFromTag("v0.1.2")).toEqual({ ok: true, version: "0.1.2" });
  });

  it("prerelease 付きの tag も通す", () => {
    expect(versionFromTag("v0.2.0-beta.1")).toEqual({ ok: true, version: "0.2.0-beta.1" });
  });

  it("build metadata 付きの tag も通す", () => {
    expect(versionFromTag("v1.0.0+build.5")).toEqual({ ok: true, version: "1.0.0+build.5" });
  });

  it("semver でない tag を落とす", () => {
    for (const bad of ["vfoo", "v1", "v1.2", "v1.2.3.4", "v01.2.3", "v-1.0.0", "v1.2.3-"]) {
      const result = versionFromTag(bad);
      expect(result.ok, `${bad} は落ちるべき`).toBe(false);
    }
  });

  it("v で始まらない tag を落とす", () => {
    const result = versionFromTag("0.1.2");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('"v"');
  });

  it("空・undefined・文字列でないものを落とす", () => {
    for (const bad of ["", undefined, null, 12, {}]) {
      expect(versionFromTag(bad).ok, `${JSON.stringify(bad)} は落ちるべき`).toBe(false);
    }
  });
});

describe("distTagFor（ADR 0070）", () => {
  it("通常の版・通常の Release は latest", () => {
    const r = distTagFor({ version: "0.1.2", githubPrerelease: false });
    expect(r.npmTag).toBe("latest");
    expect(r.warnings).toEqual([]);
  });

  it("GitHub 側で pre-release にした Release は next", () => {
    const r = distTagFor({ version: "0.1.2", githubPrerelease: true });
    expect(r.npmTag).toBe("next");
    expect(r.warnings).toHaveLength(1);
  });

  it("semver が prerelease なら、GitHub 側のチェックが無くても next", () => {
    const r = distTagFor({ version: "0.2.0-beta.1", githubPrerelease: false });
    expect(r.npmTag).toBe("next");
    expect(r.warnings).toHaveLength(1);
  });

  it("両方 prerelease なら next で、警告は出ない", () => {
    const r = distTagFor({ version: "0.2.0-beta.1", githubPrerelease: true });
    expect(r.npmTag).toBe("next");
    expect(r.warnings).toEqual([]);
  });

  // 安全側に倒す。latest の誤汚染は取り消せないが、next への入れ違いは dist-tag add で直せる。
  it("食い違ったときは latest ではなく next へ倒す", () => {
    expect(distTagFor({ version: "0.2.0-beta.1", githubPrerelease: false }).npmTag).toBe("next");
    expect(distTagFor({ version: "0.1.2", githubPrerelease: true }).npmTag).toBe("next");
  });
});
