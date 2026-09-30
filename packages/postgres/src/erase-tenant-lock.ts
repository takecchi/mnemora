import { sql } from "drizzle-orm";
import { deriveAdvisoryLockKey } from "./advisory-lock.js";
import type { Db } from "./client.js";

/**
 * 同じテナントへの `eraseTenant` の同時呼び出しを直列にするための、テナント単位の advisory lock
 * （[ADR 0430](../../../docs/decisions/0430-concurrent-create-erase-and-standalone-params.md) 決定2）。
 *
 * `eraseTenant` の各 port（`PostgresMemoryStore`・`PostgresVectorStore`・`PostgresOutboxStore`）は、
 * 消せた行数が予算（`limit`）未満なら「その表は空になった」と読む。同じテナントを別の呼び出しが
 * 同時に消していると、相手が先に消した行は自分の `DELETE` に数えられず、行が残っているのに
 * 「空」と読んで先へ進む（`memories` では 23503、外部キー違反）。トランザクションの先頭でこの lock を
 * 取ると、後から来た呼び出しは先の呼び出しのコミットを待ち、コミット後の状態から数え始める。
 *
 * - キーは `deriveAdvisoryLockKey` で、テナントごとに固定文字列から導く（別テナントは待たない）。
 * - `pg_advisory_xact_lock` はトランザクションの終わりで自動的に外れる。解放の後始末も、待ち時間の
 *   上限（`lock_timeout` を mnemora が敷くこと）も持たない。利用者の `lock_timeout` /
 *   `statement_timeout` は効く。
 * - 4つの port は別々のトランザクションで順に呼ばれる（`@mnemora/core` の `eraseTenant`）。
 *   同時に2本のトランザクションが lock を保持する形は無いので、同じキーを共有してもデッドロックしない。
 */
export function eraseTenantLockKey(tenantId: string): bigint {
  return deriveAdvisoryLockKey(`mnemora:eraseTenant:${tenantId}`);
}

/** トランザクション `tx` の先頭で呼ぶ。 */
export async function lockTenantForErase(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${eraseTenantLockKey(tenantId).toString()}::bigint)`);
}
