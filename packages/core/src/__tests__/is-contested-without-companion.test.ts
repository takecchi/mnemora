import { describe, expect, it } from "vitest";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import { isContestedWithoutCompanion } from "../interfaces/memory-store.js";

/**
 * `isContestedWithoutCompanion`（ADR 0140）の TSDoc が約束していることの直接の歯。
 *
 * TSDoc の約束: 「`status: 'contested'` で対向（`contestedWithId`）が無い」ときだけ `true`。
 * **対向があるかどうかだけを見る**（Issue #854 の追記）——`contestedWithId` が指す先が同じテナントの行かは
 * 見ない。`null` と `undefined` はどちらも「無い」。`contested` 以外の status は対向の有無に関わらず `false`。
 */

const STATUSES: MemoryStatus[] = ["active", "contested", "superseded", "archived", "forgotten"];
const SOME_ID = "11111111-1111-4111-8111-111111111111" as MemoryId;

describe("isContestedWithoutCompanion", () => {
  it("contested で対向が null・undefined（省略）のときだけ true", () => {
    expect(isContestedWithoutCompanion("contested", null)).toBe(true);
    expect(isContestedWithoutCompanion("contested", undefined)).toBe(true);
  });

  it("contested でも対向があれば false", () => {
    expect(isContestedWithoutCompanion("contested", SOME_ID)).toBe(false);
  });

  it("contested 以外の status は、対向の有無に関わらず false（status の省略も含む）", () => {
    for (const status of STATUSES.filter((s) => s !== "contested")) {
      expect(isContestedWithoutCompanion(status, null), `${status}/null`).toBe(false);
      expect(isContestedWithoutCompanion(status, undefined), `${status}/undefined`).toBe(false);
      expect(isContestedWithoutCompanion(status, SOME_ID), `${status}/id`).toBe(false);
    }
    expect(isContestedWithoutCompanion(undefined, null)).toBe(false);
    expect(isContestedWithoutCompanion(undefined, undefined)).toBe(false);
    expect(isContestedWithoutCompanion(undefined, SOME_ID)).toBe(false);
  });

  it("対向の指す先が何であっても（自分のテナントの行か・存在するかを問わず）対向が『在る』なら false（Issue #854）", () => {
    // 判定は id の中身を見ない。他テナントの id・存在しない id・形式の違う文字列でも、null 以外なら対向が在る扱い。
    for (const id of ["00000000-0000-4000-8000-000000000000", "other-tenants-row", "x"]) {
      expect(isContestedWithoutCompanion("contested", id as MemoryId), id).toBe(false);
    }
  });
});
