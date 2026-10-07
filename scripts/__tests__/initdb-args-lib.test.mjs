import { describe, expect, it } from "vitest";
import {
  ANY_ENCODING,
  findInconsistentLegs,
  impliedEncodingForLocale,
  parseInitdbArgs,
} from "../initdb-args-lib.mjs";

describe("parseInitdbArgs", () => {
  it("--encoding= と --locale= の両方を持つ文字列から両方を取り出す", () => {
    expect(parseInitdbArgs("--encoding=SQL_ASCII --locale=C")).toEqual({
      encoding: "SQL_ASCII",
      locale: "C",
    });
  });

  it("--locale= が無ければ locale は undefined(⛔ 無条件に要求しない)", () => {
    expect(parseInitdbArgs("--encoding=UTF8")).toEqual({
      encoding: "UTF8",
      locale: undefined,
    });
  });
});

describe("impliedEncodingForLocale", () => {
  it("locale が undefined(既定ロケール)なら UTF8 を含意する", () => {
    expect(impliedEncodingForLocale(undefined)).toBe("UTF8");
  });

  it("locale が C なら ANY_ENCODING(どの encoding とも両立する)を返す", () => {
    expect(impliedEncodingForLocale("C")).toBe(ANY_ENCODING);
  });

  it("locale が POSIX でも ANY_ENCODING を返す(C と同じ扱い【実測】)", () => {
    expect(impliedEncodingForLocale("POSIX")).toBe(ANY_ENCODING);
  });

  it("locale が C.utf8 なら UTF8 を含意する(ANY_ENCODING ではない)", () => {
    expect(impliedEncodingForLocale("C.utf8")).toBe("UTF8");
  });

  it("未知のロケールは undefined(『わからない』)を返す(⛔ わかったことにして通さない)", () => {
    expect(impliedEncodingForLocale("en_US.utf8")).toBeUndefined();
  });
});

describe("findInconsistentLegs(陰性対照: 集合の一致で書く)", () => {
  it("自己無矛盾な脚(UTF8/既定ロケール、SQL_ASCII/--locale=C)と、矛盾する脚を混ぜても、矛盾する脚だけを集合で挙げる", () => {
    const legs = [
      { serverEncoding: "UTF8", initdbArgs: "--encoding=UTF8" },
      { serverEncoding: "SQL_ASCII", initdbArgs: "--encoding=SQL_ASCII --locale=C" },
      // `--locale=C` / `POSIX` はどの encoding とも両立するので挙げない（ADR 0196）。
      {
        serverEncoding: "WAS_E3_UTF8_WITH_LOCALE_C",
        initdbArgs: "--encoding=WAS_E3_UTF8_WITH_LOCALE_C --locale=C",
      },
      { serverEncoding: "LOCALE_POSIX", initdbArgs: "--encoding=LOCALE_POSIX --locale=POSIX" },
      { serverEncoding: "MUTATED_E1", initdbArgs: "--encoding=MUTATED_E1" },
      {
        serverEncoding: "MUTATED_KNOWN_LOCALE",
        initdbArgs: "--encoding=MUTATED_KNOWN_LOCALE --locale=C.utf8",
      },
    ];

    const flaggedNames = new Set(findInconsistentLegs(legs).map((leg) => leg.serverEncoding));

    expect(flaggedNames).toEqual(new Set(["MUTATED_E1", "MUTATED_KNOWN_LOCALE"]));

    // 件数（`toBeGreaterThan`）では書かない（入力が1件でもあれば常に真になる）。
    const notFlaggedNames = new Set(
      legs.map((leg) => leg.serverEncoding).filter((name) => !flaggedNames.has(name)),
    );
    expect(notFlaggedNames).toEqual(
      new Set(["UTF8", "SQL_ASCII", "WAS_E3_UTF8_WITH_LOCALE_C", "LOCALE_POSIX"]),
    );
  });

  it("未知のロケール(Issue #162 E2 相当)は、既知のロケールを持つ脚と混ぜても単独で挙げる", () => {
    const legs = [
      { serverEncoding: "SQL_ASCII", initdbArgs: "--encoding=SQL_ASCII --locale=C" },
      { serverEncoding: "MUTATED_E2", initdbArgs: "--encoding=MUTATED_E2 --locale=en_US.utf8" },
    ];

    const flaggedNames = new Set(findInconsistentLegs(legs).map((leg) => leg.serverEncoding));

    expect(flaggedNames).toEqual(new Set(["MUTATED_E2"]));
    expect(
      new Set(legs.map((leg) => leg.serverEncoding).filter((name) => !flaggedNames.has(name))),
    ).toEqual(new Set(["SQL_ASCII"]));
  });

  it("空配列を渡せば何も挙げない(⚠ これ単独は陰性対照として数えない。空=空の主張でしかない)", () => {
    expect(findInconsistentLegs([])).toEqual([]);
  });
});
