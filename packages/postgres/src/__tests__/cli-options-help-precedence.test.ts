import { describe, expect, it } from "vitest";
import { parseMigrateCliOptions } from "../bin/cli-options.js";

/**
 * `--help` / `-h` の優先（`parseMigrateCliOptions` の doc: argv のどこにあっても、他の一切より先に勝つ）の、
 * `cli-options.test.ts` が見ていない側。DB は要らない。
 *
 * - `--` と一緒でも help を返す（`pnpm run migrate -- --help` は `--` ごと渡ってくる）。
 * - 見分けは完全一致: `--help=1`・`--helper`・`-hx` のような似た綴りや、値の位置に埋まった `-h` を help と読まない。
 * - 不正な環境変数と一緒でも help を返す（使い方を見たいだけの利用者に、設定の不備を見せない）。
 */

describe("parseMigrateCliOptions: --help は --（pnpm が渡す区切り）と一緒でも勝つ", () => {
  it.each([
    [["--", "--help"]],
    [["--help", "--"]],
    [["--", "-h"]],
    [["--schema", "app", "--", "--help"]],
  ])("%j は help を返す", (argv) => {
    const result = parseMigrateCliOptions(argv, {});
    expect(result).toEqual({ ok: true, options: { help: true } });
  });
});

describe("parseMigrateCliOptions: help と読むのは --help と -h の完全一致だけ", () => {
  it.each([
    ["--help=1"],
    ["--helper"],
    ["--help-me"],
    ["-hx"],
    ["-help"],
    ["--schema=-h"],
    ["--schema=app-h"],
  ])("%s は help ではなく、解釈に失敗する", (arg) => {
    const result = parseMigrateCliOptions([arg], {});
    expect(result.ok).toBe(false);
  });
});

describe("parseMigrateCliOptions: 不正な環境変数と一緒でも --help は勝つ", () => {
  it.each([
    ["MNEMORA_EXTENSION_MODE が create / verify 以外", { MNEMORA_EXTENSION_MODE: "bogus" }],
    ["MNEMORA_SCHEMA が不正なスキーマ名", { MNEMORA_SCHEMA: "Bad-Name" }],
    [
      "MNEMORA_EXTENSION_SCHEMA だけがある（--schema 側が無い）",
      { MNEMORA_EXTENSION_SCHEMA: "ext_only" },
    ],
  ])("%s", (_label, env) => {
    expect(parseMigrateCliOptions(["--help"], env)).toEqual({
      ok: true,
      options: { help: true },
    });
    expect(parseMigrateCliOptions(["-h"], env)).toEqual({ ok: true, options: { help: true } });
  });
});
