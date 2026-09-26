import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";

/**
 * `PostgresMemoryStore.resolveOrphanedContested`（Issue #825、ADR 0150 追記）の、
 * **DB に触れる前**の書き込み前ガードだけを検査する。`resolve-contested-pair-guard.test.ts`
 * と同じ形——この作業環境では `*.postgres.test.ts` を DB 無しには実行できないため、
 * DB に触れる前の純粋な分岐だけをここで切り出して検査する。
 *
 * ⚠ **CAS・トランザクション・SQL そのものの正しさはここでは検査しない。**それは
 * `resolve-orphaned-contested.postgres.test.ts`（本物の Postgres + pgvector 必須）が担う。
 *
 * ⚠ このファイルは `packages/postgres` の `test:db`（`vitest run`、DB 必須）経由でしか
 * package.json のスクリプトからは走らない。手元で DB 無しに実行するときは
 * `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/resolve-orphaned-contested-guard.test.ts`
 * のように、このファイルを名指しで直接 vitest に渡すこと。
 */
const UNREACHABLE_DB = {} as unknown as Db;

const ctx: Ctx = { tenantId: "tenant-1" };

function event(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested_resolved", resolution: "orphan_reclaimed" },
  };
}

describe("PostgresMemoryStore.resolveOrphanedContested — 書き込み前ガード（DB 不要）", () => {
  it("survivor.id が UUID の形でなければ「memory not found」を投げ、DB には一切触れない", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const badId = "not-a-uuid";
    const contestedWithId = randomUUID();

    await expect(
      store.resolveOrphanedContested!(ctx, {
        id: badId,
        contestedWithId,
        event: event(badId),
      }),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("survivor.id が UUID の形をしていれば、ガードを素通しして DB スタブに実際に到達する（「memory not found」ではない失敗になる）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const id = randomUUID();
    const contestedWithId = randomUUID();

    const rejection = expect(
      store.resolveOrphanedContested!(ctx, { id, contestedWithId, event: event(id) }),
    ).rejects;
    await rejection.not.toThrow(/memory not found for tenant/);
  });
});
