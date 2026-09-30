import { describe, expect, it } from "vitest";
import {
  ContestedGroupMembershipMismatchError,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
  SourceMemoryForgottenError,
  isContestedGroupMembershipMismatchError,
  isMemoryPurgeConflictError,
  isMemoryStatusConflictError,
  isSourceMemoryForgottenError,
} from "../interfaces/memory-store.js";
import {
  OutboxLeaseConflictError,
  isOutboxLeaseConflictError,
} from "../interfaces/outbox-store.js";

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

  it("他の4種の例外は通らない", () => {
    for (const other of cases) {
      if (other.name !== name) {
        expect(guard(other.make())).toBe(false);
      }
    }
  });
});
