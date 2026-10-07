import { runInNewContext } from "node:vm";
import type { MemoryStore, OutboxStore } from "@mnemora/core";
import { describeMemoryStoreConformance } from "../memory-store-conformance.js";
import { describeOutboxStoreConformance } from "../outbox-store-conformance.js";
import {
  inMemoryMemoryStoreConformanceOptions,
  inMemoryOutboxStoreConformanceOptions,
} from "./in-memory-conformance-options.js";

const KIND_BY_NAME: Record<string, string> = {
  OutboxLeaseConflictError: "outbox_lease_conflict",
  MemoryStatusConflictError: "memory_status_conflict",
  ContestedGroupMembershipMismatchError: "contested_group_membership_mismatch",
  SourceMemoryForgottenError: "source_memory_forgotten",
  SourceMemoryStatusChangedError: "source_memory_status_changed",
  MemoryPurgeConflictError: "memory_purge_conflict",
  ContestedWithoutCompanionError: "contested_without_companion",
  RecallOutputValidationError: "recall_output_validation",
};

const VARIANTS = [
  { label: "kind 無し（古い core）", withKind: false },
  { label: "kind 有り（別の realm の新しい core）", withKind: true },
] as const;

function foreignError(name: string, fields: Record<string, unknown>, kind: string | null): Error {
  const make = runInNewContext(`
    (function (fields, kind) {
      class ${name} extends Error {
        constructor() {
          super("foreign ${name}");
          this.name = "${name}";
          Object.assign(this, fields);
          if (kind !== null) { this.kind = kind; }
        }
      }
      return new ${name}();
    })
  `) as (f: Record<string, unknown>, k: string | null) => Error;
  return make(fields, kind);
}

function toForeign(error: unknown, withKind: boolean): unknown {
  if (!(error instanceof Error) || !(error.name in KIND_BY_NAME)) {
    return error;
  }
  const {
    kind: _kind,
    name: _name,
    message: _message,
    ...fields
  } = error as unknown as Record<string, unknown>;
  return foreignError(error.name, fields, withKind ? KIND_BY_NAME[error.name]! : null);
}

function foreignRealmStore<T extends object>(store: T, withKind: boolean): T {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (
            typeof result === "object" &&
            result !== null &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            return (result as Promise<unknown>).then(undefined, (error: unknown) => {
              throw toForeign(error, withKind);
            });
          }
          return result;
        } catch (error) {
          throw toForeign(error, withKind);
        }
      };
    },
  });
}

for (const variant of VARIANTS) {
  describeMemoryStoreConformance({
    ...inMemoryMemoryStoreConformanceOptions((store: MemoryStore) =>
      foreignRealmStore(store, variant.withKind),
    ),
    name: `in-memory placeholder（core の例外が別 realm: ${variant.label}）`,
  });
  describeOutboxStoreConformance({
    ...inMemoryOutboxStoreConformanceOptions((store: OutboxStore) =>
      foreignRealmStore(store, variant.withKind),
    ),
    name: `in-memory placeholder（core の例外が別 realm: ${variant.label}）`,
  });
}
