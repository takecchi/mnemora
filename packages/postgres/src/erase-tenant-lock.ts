import { sql } from "drizzle-orm";
import { deriveAdvisoryLockKey } from "./advisory-lock.js";
import type { Db } from "./client.js";

/**
 * 同じテナントへの `eraseTenant` の同時呼び出しを直列にする、テナント単位の advisory lock
 * （[ADR 0430](../../../docs/decisions/0430-concurrent-create-erase-and-standalone-params.md) 決定2）。
 *
 * 各 port は「消せた行数が予算未満なら、その表は空になった」と読む。同じテナントを別の呼び出しが
 * 同時に消していると、相手が先に消した行は自分の `DELETE` に数えられず、行が残っているのに空と読んで
 * 先へ進む（`memories` では外部キー違反の 23503）。トランザクションの先頭でこの lock を取れば、
 * 後から来た呼び出しは先の呼び出しのコミットを待つ。
 *
 * - キーはテナントごとに導くので、別テナントは待たない。
 * - 4つの port は別々のトランザクションで順に呼ばれ、同時に lock を保持する形は無い。
 *   だから同じキーを共有してもデッドロックしない。
 * - mnemora は `lock_timeout` を敷かない。利用者の `lock_timeout` / `statement_timeout` は効く。
 */
export function eraseTenantLockKey(tenantId: string): bigint {
  return deriveAdvisoryLockKey(`mnemora:eraseTenant:${tenantId.toLowerCase()}`);
}

export async function lockTenantForErase(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${eraseTenantLockKey(tenantId).toString()}::bigint)`,
  );
}
