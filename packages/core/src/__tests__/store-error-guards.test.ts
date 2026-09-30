import { describe, expect, it } from "vitest";
import {
  ContestedGroupMembershipMismatchError,
  ContestedWithoutCompanionError,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
  SourceMemoryForgottenError,
  isContestedGroupMembershipMismatchError,
  isContestedWithoutCompanionError,
  isMemoryPurgeConflictError,
  isMemoryStatusConflictError,
  isSourceMemoryForgottenError,
} from "../interfaces/memory-store.js";
import {
  OutboxLeaseConflictError,
  isOutboxLeaseConflictError,
} from "../interfaces/outbox-store.js";
import {
  RecallOutputValidationError,
  isRecallOutputValidationError,
} from "../recall-output-validation.js";
import {
  FOREIGN_VARIANTS,
  foreignContestedWithoutCompanion,
  foreignError,
  foreignRecallOutputValidation,
} from "./foreign-realm-errors.js";

/**
 * ADR 0418: store 例外は `kind`（値）を持ち、判定関数は「`kind`、無ければ `name`」で見る。
 * 実処理への効き（tick / restoreArchived）は `foreign-realm-store-errors.test.ts` が見る。
 */

const cases = [
  {
    name: "OutboxLeaseConflictError",
    kind: "outbox_lease_conflict",
    guard: isOutboxLeaseConflictError,
    make: () => new OutboxLeaseConflictError("j", 1, 2),
  },
  {
    name: "MemoryStatusConflictError",
    kind: "memory_status_conflict",
    guard: isMemoryStatusConflictError,
    make: () => new MemoryStatusConflictError("m", "archived", "active"),
  },
  {
    name: "ContestedGroupMembershipMismatchError",
    kind: "contested_group_membership_mismatch",
    guard: isContestedGroupMembershipMismatchError,
    make: () => new ContestedGroupMembershipMismatchError("m"),
  },
  {
    name: "SourceMemoryForgottenError",
    kind: "source_memory_forgotten",
    guard: isSourceMemoryForgottenError,
    make: () => new SourceMemoryForgottenError("createMemoryWithOutbox", ["m"]),
  },
  {
    name: "MemoryPurgeConflictError",
    kind: "memory_purge_conflict",
    guard: isMemoryPurgeConflictError,
    make: () => new MemoryPurgeConflictError("m", "active", null),
  },
  // ADR 0418 追記（2026-09-30）: runtime が instanceof で分岐していなかった2クラス。
  {
    name: "ContestedWithoutCompanionError",
    kind: "contested_without_companion",
    guard: isContestedWithoutCompanionError,
    make: () => new ContestedWithoutCompanionError("createMemory", null),
  },
  {
    name: "RecallOutputValidationError",
    kind: "recall_output_validation",
    guard: isRecallOutputValidationError,
    make: () => new RecallOutputValidationError([], "r"),
  },
] as const;

describe.each(cases)("$name の判定関数", ({ name, kind, guard, make }) => {
  it("本物のインスタンスは kind を持ち、判定に通る", () => {
    const e = make();
    expect((e as { kind: string }).kind).toBe(kind);
    expect(e.name).toBe(name);
    expect(guard(e)).toBe(true);
  });

  it("kind を持たず name だけが一致するもの（古い core が投げたもの）も通る", () => {
    const old = Object.assign(new Error("old"), { name });
    expect(guard(old)).toBe(true);
  });

  it("kind が一致するもの（name が違っても）は通る", () => {
    expect(guard({ kind, name: "SomethingElse" })).toBe(true);
  });

  it("kind が在るときは kind を優先する——kind が別の種類なら、name が一致しても通らない", () => {
    expect(guard({ kind: "some_other_kind", name })).toBe(false);
  });

  it("無関係な値は通らない", () => {
    expect(guard(new Error("boom"))).toBe(false);
    expect(guard(null)).toBe(false);
    expect(guard(undefined)).toBe(false);
    expect(guard("OutboxLeaseConflictError")).toBe(false);
    expect(guard({})).toBe(false);
  });

  it("他の種類の例外は通らない", () => {
    for (const other of cases) {
      if (other.name !== name) {
        expect(guard(other.make())).toBe(false);
      }
    }
  });
});

/**
 * 別の realm（`vm`）で定義し直したクラスでも通る（`kind` 無し・有りの両方）。
 * 全7クラスを対象にする。陽性対照として、本物のクラスの `instanceof` は false になることも見る。
 */
const foreignCases = [
  {
    name: "OutboxLeaseConflictError",
    real: OutboxLeaseConflictError,
    guard: isOutboxLeaseConflictError,
  },
  {
    name: "MemoryStatusConflictError",
    real: MemoryStatusConflictError,
    guard: isMemoryStatusConflictError,
  },
  {
    name: "ContestedGroupMembershipMismatchError",
    real: ContestedGroupMembershipMismatchError,
    guard: isContestedGroupMembershipMismatchError,
  },
  {
    name: "SourceMemoryForgottenError",
    real: SourceMemoryForgottenError,
    guard: isSourceMemoryForgottenError,
  },
  {
    name: "MemoryPurgeConflictError",
    real: MemoryPurgeConflictError,
    guard: isMemoryPurgeConflictError,
  },
  {
    name: "ContestedWithoutCompanionError",
    real: ContestedWithoutCompanionError,
    guard: isContestedWithoutCompanionError,
  },
  {
    name: "RecallOutputValidationError",
    real: RecallOutputValidationError,
    guard: isRecallOutputValidationError,
  },
] as const;

describe.each(FOREIGN_VARIANTS)("別の realm のクラス — $label", (variant) => {
  it.each(foreignCases)(
    "$name: instanceof は false だが、判定関数は通る",
    ({ name, real, guard }) => {
      const foreign = foreignError(name, {}, variant);
      expect(foreign instanceof real).toBe(false);
      expect(guard(foreign)).toBe(true);
      expect((foreign as { kind?: string }).kind !== undefined).toBe(variant.withKind);
    },
  );

  it.each(foreignCases)("$name: 他の種類の別 realm の例外は通らない", ({ name, guard }) => {
    for (const other of foreignCases) {
      if (other.name !== name) {
        expect(guard(foreignError(other.name, {}, variant))).toBe(false);
      }
    }
  });

  it("新しい2クラスは、欄も別 realm のまま読める", () => {
    const companion = foreignContestedWithoutCompanion("createMemory", null, variant);
    expect(isContestedWithoutCompanionError(companion)).toBe(true);
    expect(companion.name).toBe("ContestedWithoutCompanionError");
    const validation = foreignRecallOutputValidation([], "r1", variant);
    expect(isRecallOutputValidationError(validation)).toBe(true);
    expect((validation as RecallOutputValidationError).recallId).toBe("r1");
  });
});
