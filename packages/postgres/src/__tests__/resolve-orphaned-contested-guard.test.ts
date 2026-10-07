import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";

/**
 * `PostgresMemoryStore.resolveOrphanedContested` の、DB に触れる前の書き込み前ガードだけを検査する。
 * `resolve-contested-pair-guard.test.ts` と同じ形で、DB に触れる前の純粋な分岐だけを切り出している。
 *
 * ⚠ CAS・トランザクション・SQL そのものの正しさはここでは検査しない。それは `resolve-orphaned-contested.postgres.test.ts` が担う。
 * 手元でDB無しに実行するときは、このファイルを名指しで直接 vitest に渡すこと。
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
