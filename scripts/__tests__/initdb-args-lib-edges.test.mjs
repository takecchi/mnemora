import { describe, expect, it } from "vitest";
import {
  ANY_ENCODING,
  findInconsistentLegs,
  impliedEncodingForLocale,
  parseInitdbArgs,
} from "../initdb-args-lib.mjs";

/**
 * `initdb-args-lib.mjs`（ADR 0196）の歯の足し（Issue #1815、09/16 マージ分の #414 の確かめ直し）。
 * 既存の `initdb-args-lib.test.mjs` が見ていなかった形だけを足す。実装は変えない。
 * **これはクローン（miku）の判断で足した歯で、オーナーの判断ではない**（ADR 0220）。
 */

describe("parseInitdbArgs は、引用符で囲まれた行から値だけを取り出す", () => {
  it('`ci.yml` の行のように値の直後に `"` が続いても、値に引用符を含めない', () => {
    expect(parseInitdbArgs('initdbArgs: "--encoding=SQL_ASCII --locale=C"')).toEqual({
      encoding: "SQL_ASCII",
      locale: "C",
    });
  });

  it("並びが逆で `--encoding=` が引用符の直前に来ても、値に引用符を含めない", () => {
    expect(parseInitdbArgs('initdbArgs: "--locale=C --encoding=SQL_ASCII"')).toEqual({
      encoding: "SQL_ASCII",
      locale: "C",
    });
  });

  it("`--encoding=` の値は、大文字小文字を変えずに返す（読み替えは比べる側の仕事）", () => {
    expect(parseInitdbArgs("--encoding=utf8").encoding).toBe("utf8");
  });
});

describe("ANY_ENCODING は encoding 名の文字列ではない（ADR 0196）", () => {
  it("Symbol である（`SQL_ASCII` を含意する、と取り違えられない）", () => {
    expect(typeof ANY_ENCODING).toBe("symbol");
  });
});

describe("`C.UTF-8` も `C.utf8` と同じく UTF8 を含意する【実測】", () => {
  it("`C.UTF-8` は UTF8", () => {
    expect(impliedEncodingForLocale("C.UTF-8")).toBe("UTF8");
  });

  it("`--locale=C.UTF-8` の SQL_ASCII 脚は、未知のロケールとしてではなく、食い違いとして挙げる", () => {
    const flagged = findInconsistentLegs([
      { serverEncoding: "SQL_ASCII", initdbArgs: "--encoding=SQL_ASCII --locale=C.UTF-8" },
    ]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].reason).toContain("encoding=UTF8 を含意する");
  });

  it("`--locale=C.UTF-8` の UTF8 脚は通す", () => {
    expect(
      findInconsistentLegs([
        { serverEncoding: "UTF8", initdbArgs: "--encoding=UTF8 --locale=C.UTF-8" },
      ]),
    ).toEqual([]);
  });
});
