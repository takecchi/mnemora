import { describe, expect, it } from "vitest";
import {
  collectExternalRuntimeDependencyNames,
  externalRuntimeDependencyNames,
  meetsRequireEsmNodeVersion,
} from "../check-cjs-require-smoke-lib.mjs";

/**
 * `scripts/check-cjs-require-smoke-lib.mjs`（`scripts/check-cjs-require-smoke.mjs` の純関数部分。
 * ADR 0387。README の「CommonJS からは Node 22.12 以降の `require(esm)` で読み込める」を毎 PR の
 * CI で確かめる、registry に出ない段）の歯。
 *
 * ⚠ ネットワークにも tarball の実際の pack/展開にも触れない——それは
 * `scripts/check-cjs-require-smoke.mjs` を直接実行したときの統合的な確認であり
 * （`pnpm run check:cjs-require-smoke`）、ここでは見ない。ここで見るのは、依存名の抽出・
 * node 版の判定という、fs にもネットワークにも触れない部分だけである
 * （本体側は import された瞬間に pack・展開・symlink・node 実行まで始めるトップレベルの処理を
 * 持つため、歯から直接 import しない——`scripts/check-cjs-require-smoke-lib.mjs` 冒頭のコメント）。
 */

describe("externalRuntimeDependencyNames", () => {
  it("dependencies と peerDependencies から、@mnemora/* を除いた名前を集める", () => {
    expect(
      externalRuntimeDependencyNames({
        dependencies: { "@mnemora/core": "workspace:^", zod: "^4.5.4" },
        peerDependencies: { vitest: "^5.0.0" },
      }),
    ).toEqual(["zod", "vitest"]);
  });

  it("dependencies も peerDependencies も無ければ空配列", () => {
    expect(externalRuntimeDependencyNames({})).toEqual([]);
  });

  it("devDependencies・optionalDependencies は対象外", () => {
    expect(
      externalRuntimeDependencyNames({
        devDependencies: { typescript: "5.9.3" },
        optionalDependencies: { "some-optional": "1.0.0" },
      }),
    ).toEqual([]);
  });
});

describe("collectExternalRuntimeDependencyNames", () => {
  it("複数パッケージぶんを集めて重複を除き、安定した順序（sort）で返す", () => {
    expect(
      collectExternalRuntimeDependencyNames([
        { dependencies: { zod: "^4.5.4" } },
        { dependencies: { zod: "^4.5.4", openai: "7.10.0" } },
        { peerDependencies: { vitest: "^5.0.0" } },
      ]),
    ).toEqual(["openai", "vitest", "zod"]);
  });

  it("@mnemora/* はどのパッケージからも除かれる", () => {
    expect(
      collectExternalRuntimeDependencyNames([
        { dependencies: { "@mnemora/core": "workspace:^" } },
        { dependencies: { "@mnemora/core": "workspace:*", "@mnemora/testkit": "workspace:*" } },
      ]),
    ).toEqual([]);
  });
});

describe("meetsRequireEsmNodeVersion", () => {
  it("22.12.0 以上は true", () => {
    expect(meetsRequireEsmNodeVersion("v22.12.0")).toBe(true);
    expect(meetsRequireEsmNodeVersion("v22.20.1")).toBe(true);
    expect(meetsRequireEsmNodeVersion("v23.0.0")).toBe(true);
    expect(meetsRequireEsmNodeVersion("v24.1.2")).toBe(true);
  });

  it("22.12.0 未満は false", () => {
    expect(meetsRequireEsmNodeVersion("v22.11.9")).toBe(false);
    expect(meetsRequireEsmNodeVersion("v20.18.0")).toBe(false);
    expect(meetsRequireEsmNodeVersion("v18.20.4")).toBe(false);
  });

  it("`v` 無し・不正な文字列も扱える", () => {
    expect(meetsRequireEsmNodeVersion("22.12.0")).toBe(true);
    expect(meetsRequireEsmNodeVersion("not-a-version")).toBe(false);
  });
});
