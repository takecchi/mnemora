import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";

/**
 * `PostgresMemoryStore.resolveContestedPair` の、DB に触れる前の書き込み前ガードだけを検査する。
 * `memory-store-contested-write-guard.test.ts` と同じ形で、DB に触れる前の純粋な分岐だけを切り出している。
 *
 * ⚠ CAS・トランザクション・SQL そのものの正しさはここでは検査しない。それは `memory-store-conformance.ts` の `resolveContestedPair` 節が担う。
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
    meta: {},
  };
}

describe("PostgresMemoryStore.resolveContestedPair — 書き込み前ガード（DB 不要）", () => {
  it("first.id === second.id は RangeError を投げ、DB には一切触れない（DB スタブに到達すれば TypeError になるはずが、そうならない）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const id = randomUUID();

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id, status: "active", event: event(id) },
        { id, status: "active", event: event(id) },
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("first.id が UUID の形でなければ「memory not found」を投げ、DB には一切触れない", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const badId = "not-a-uuid";
    const goodId = randomUUID();

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id: badId, status: "active", event: event(badId) },
        { id: goodId, status: "superseded", supersededById: badId, event: event(goodId) },
      ),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("second.id が UUID の形でなければ「memory not found」を投げ、DB には一切触れない", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const goodId = randomUUID();
    const badId = "not-a-uuid";

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id: goodId, status: "active", event: event(goodId) },
        { id: badId, status: "active", event: event(badId) },
      ),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("両側とも id が UUID の形をしていて first.id !== second.id なら、ガードを素通しして DB スタブに実際に到達する（RangeError でも「memory not found」でもない失敗になる）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const first = randomUUID();
    const second = randomUUID();

    const rejection = expect(
      store.resolveContestedPair!(
        ctx,
        { id: first, status: "active", event: event(first) },
        { id: second, status: "superseded", supersededById: first, event: event(second) },
      ),
    ).rejects;
    await rejection.not.toBeInstanceOf(RangeError);
    await rejection.not.toThrow(/memory not found for tenant/);
  });
});
