import { runInNewContext } from "node:vm";

/**
 * 「別の realm の store 例外」を作る道具（ADR 0418）。
 *
 * 利用者の手元で `@mnemora/core` が2つの版に分かれると、adapter が投げる store 例外は
 * runtime 側のクラスの `instanceof` で false になる。ここでは `vm` の別 context で
 * クラスを定義し直して、それを再現する——`foreign instanceof RealClass` は常に false である。
 *
 * - `withKind: true`  ⟹ 判別子 `kind` を持つ版の core が投げたもの
 * - `withKind: false` ⟹ 判別子がまだ無い古い版の core が投げたもの（`name` だけで見分けるしかない）
 */
export type ForeignVariant = { readonly withKind: boolean };

export const FOREIGN_VARIANTS: readonly (ForeignVariant & { readonly label: string })[] = [
  { label: "kind 無し（古い core）", withKind: false },
  { label: "kind 有り（別の realm の新しい core）", withKind: true },
];

const KIND_BY_NAME: Record<string, string> = {
  OutboxLeaseConflictError: "outbox_lease_conflict",
  MemoryStatusConflictError: "memory_status_conflict",
  ContestedGroupMembershipMismatchError: "contested_group_membership_mismatch",
  SourceMemoryForgottenError: "source_memory_forgotten",
  MemoryPurgeConflictError: "memory_purge_conflict",
};

/** 別の realm で定義したクラスの、コンストラクタ引数をそのまま欄に写したインスタンスを返す。 */
function foreignError(
  name: keyof typeof KIND_BY_NAME,
  fields: Record<string, unknown>,
  variant: ForeignVariant,
): Error {
  const source = `
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
  `;
  const make = runInNewContext(source) as (f: Record<string, unknown>, k: string | null) => Error;
  return make(fields, variant.withKind ? (KIND_BY_NAME[name] ?? null) : null);
}

export function foreignOutboxLeaseConflict(
  jobId: string,
  expectedAttempts: number,
  observedAttempts: number | null,
  variant: ForeignVariant,
): Error {
  return foreignError(
    "OutboxLeaseConflictError",
    { jobId, expectedAttempts, observedAttempts },
    variant,
  );
}

export function foreignMemoryStatusConflict(
  memoryId: string,
  expectedStatus: string,
  observedStatus: string | null,
  variant: ForeignVariant,
): Error {
  return foreignError(
    "MemoryStatusConflictError",
    { memoryId, expectedStatus, observedStatus },
    variant,
  );
}
