import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREATE_EXTENSION_PERMISSION_HINT,
  describeMigrationFailure,
  isCreateExtensionPermissionDenied,
} from "../migration-failure-message.js";

function pgError(fields: { message: string; code?: string; routine?: string }): Error {
  return Object.assign(new Error(fields.message), fields);
}

describe("案内が付くかどうかは code と routine で決まり、message は見ない（Issue #1212）", () => {
  it("message が英語でなくても（lc_messages が訳された文言）、code と routine が揃えば案内を足す", () => {
    const err = pgError({
      message: '拡張機能 "vector" を作成する権限がありません',
      code: "42501",
      routine: "execute_extension_script",
    });

    expect(describeMigrationFailure("0001_init.sql", err)).toBe(
      'migration 0001_init.sql failed: 拡張機能 "vector" を作成する権限がありません' +
        CREATE_EXTENSION_PERMISSION_HINT,
    );
    expect(isCreateExtensionPermissionDenied(err)).toBe(true);
  });

  it("message が権限不足に見えても、code と routine が揃わなければ案内を足さない", () => {
    const text = 'permission denied to create extension "vector"';
    const noFields = pgError({ message: text });
    const codeOnly = pgError({ message: text, code: "42501" });
    const routineOnly = pgError({ message: text, routine: "execute_extension_script" });

    for (const err of [noFields, codeOnly, routineOnly]) {
      expect(describeMigrationFailure("0001_init.sql", err)).toBe(
        `migration 0001_init.sql failed: ${text}`,
      );
      expect(isCreateExtensionPermissionDenied(err)).toBe(false);
    }
  });

  it("routine は execute_extension_script と完全に一致したときだけで、似た名前には案内を足さない", () => {
    for (const routine of [
      "execute_extension_script_",
      "_execute_extension_script",
      "execute_extension",
      "extension_config_remove",
      "EXECUTE_EXTENSION_SCRIPT",
    ]) {
      const err = pgError({ message: "permission denied", code: "42501", routine });

      expect(isCreateExtensionPermissionDenied(err), routine).toBe(false);
      expect(describeMigrationFailure("0001_init.sql", err)).toBe(
        "migration 0001_init.sql failed: permission denied",
      );
    }
  });

  it("code と routine は同じエラーの上で揃っていなければならず、連鎖の別の段に分かれていても案内を足さない", () => {
    const routineBelow = pgError({
      message: "syntax error inside an extension script",
      code: "42601",
      routine: "execute_extension_script",
    });
    const codeAbove = Object.assign(
      new Error("permission denied for schema public", { cause: routineBelow }),
      { code: "42501", routine: "aclcheck_error" },
    );

    expect(isCreateExtensionPermissionDenied(codeAbove)).toBe(false);
    expect(describeMigrationFailure("0001_init.sql", codeAbove)).toBe(
      "migration 0001_init.sql failed: permission denied for schema public",
    );

    const codeBelow = pgError({
      message: "permission denied",
      code: "42501",
      routine: "aclcheck_error",
    });
    const routineAbove = Object.assign(new Error("extension script failed", { cause: codeBelow }), {
      code: "42601",
      routine: "execute_extension_script",
    });

    expect(isCreateExtensionPermissionDenied(routineAbove)).toBe(false);
  });
});

describe("案内が指す文書は実在する（Issue #1212）", () => {
  const repoRoot = new URL("../../../../", import.meta.url);

  it("案内の括弧の中の文書が、リポジトリの中に在り、接続先に要る拡張の項目を持つ", () => {
    const match = /（(\S+\.md) の、接続先に要る拡張の項目）/.exec(CREATE_EXTENSION_PERMISSION_HINT);
    expect(match, "案内の文面から文書名を取り出せない（文面の形が変わった）").not.toBeNull();
    const target = new URL(match![1]!, repoRoot);

    expect(existsSync(target), `案内が指す ${match![1]} が無い`).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("接続先には次の3拡張が要る");
  });
});

describe("cause が null・文字列・数値でも、文言を作る関数は投げない", () => {
  for (const [label, cause] of [
    ["null", null],
    ["文字列", "boom"],
    ["数値", 42],
    ["undefined", undefined],
  ] as const) {
    it(`cause が ${label}: 今の文言のまま返り、案内は付かない`, () => {
      const err = new Error("migration body failed", { cause });

      expect(() => describeMigrationFailure("0005_x.sql", err)).not.toThrow();
      expect(describeMigrationFailure("0005_x.sql", err)).toBe(
        "migration 0005_x.sql failed: migration body failed",
      );
      expect(isCreateExtensionPermissionDenied(err)).toBe(false);
    });
  }

  it("cause の連鎖の途中が null で終わっていても、手前に pg のエラーが在れば案内を足す", () => {
    const pg = pgError({
      message: 'permission denied to create extension "vector"',
      code: "42501",
      routine: "execute_extension_script",
    });
    const outer = new Error("wrapper", { cause: pg });

    expect(describeMigrationFailure("0001_init.sql", outer)).toBe(
      "migration 0001_init.sql failed: wrapper" + CREATE_EXTENSION_PERMISSION_HINT,
    );
    expect(isCreateExtensionPermissionDenied(new Error("end", { cause: null }))).toBe(false);
  });
});
