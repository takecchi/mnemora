import { describe, expect, it } from "vitest";
import {
  CREATE_EXTENSION_PERMISSION_HINT,
  describeMigrationFailure,
} from "../migration-failure-message.js";

/**
 * `runMigrations` の1ファイルの失敗の文言（Issue #1212）を **DB 無しで**検査する歯。
 *
 * 本物の Postgres で「拡張を作る権限が無いロール」に当てる歯は
 * `extension-mode.postgres.test.ts` の測定4a に在る。ここでは、案内が付く条件の境目
 * （`code` と `routine` の両方）と、付かないときに文言が1バイトも変わらないことを縛る。
 * pg のエラーの欄の値は、PostgreSQL 17 で実測したもの。
 */

function pgError(fields: { message: string; code?: string; routine?: string }): Error {
  return Object.assign(new Error(fields.message), fields);
}

describe("describeMigrationFailure（Issue #1212）", () => {
  it("CREATE EXTENSION の権限不足（42501・execute_extension_script）なら、今の文言の後ろに案内を足す", () => {
    const err = pgError({
      message: 'permission denied to create extension "vector"',
      code: "42501",
      routine: "execute_extension_script",
    });

    const message = describeMigrationFailure("0001_init.sql", err);

    expect(message).toBe(
      'migration 0001_init.sql failed: permission denied to create extension "vector"' +
        CREATE_EXTENSION_PERMISSION_HINT,
    );
    expect(message.split("\n")[0]).toBe(
      'migration 0001_init.sql failed: permission denied to create extension "vector"',
    );
    expect(message).toContain('extensionMode: "verify"');
    expect(message).toContain("--extension-mode verify");
  });

  it("同じ 42501 でも、スキーマの権限不足（aclcheck_error）には案内を足さない", () => {
    const err = pgError({
      message: "permission denied for schema public",
      code: "42501",
      routine: "aclcheck_error",
    });

    expect(describeMigrationFailure("0001_init.sql", err)).toBe(
      "migration 0001_init.sql failed: permission denied for schema public",
    );
  });

  it("42501 でない失敗・routine の無いエラー・pg でない Error には案内を足さない（今までの文言のまま）", () => {
    const syntax = pgError({
      message: 'syntax error at or near "CREAT"',
      code: "42601",
      routine: "scanner_yyerror",
    });
    expect(describeMigrationFailure("0002_x.sql", syntax)).toBe(
      'migration 0002_x.sql failed: syntax error at or near "CREAT"',
    );

    const noRoutine = pgError({ message: "permission denied", code: "42501" });
    expect(describeMigrationFailure("0002_x.sql", noRoutine)).toBe(
      "migration 0002_x.sql failed: permission denied",
    );

    expect(describeMigrationFailure("0002_x.sql", new Error("boom"))).toBe(
      "migration 0002_x.sql failed: boom",
    );
  });
});
