import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * わざと参照先が別バッチになるデータを作る（`limit` を小さくする）。`mem[0]`（誰も指さない）→ `mem[1].supersededById = mem[0].id` →
 * `mem[2].supersededById = mem[1].id` → … という鎖で、挿入順は `mem[0]` が最初。`limit` で区切った削除が挿入順に進むと仮定すると、
 * `mem[0]`（`mem[1]` から参照されている親）が最初のバッチで削除されようとし、`NULL` 化が無ければ即座に FK 違反になる。
 * この仮定が外れて別の順序で消えても、鎖の途中のどこかで同じ形の「親が先に消される」瞬間が起きる。
 * `limit: 1` で全要素数ぶん呼び出すことで、この機会を最大化してある。
 */

afterAll(async () => {
  await closeTestClient();
});

const CHAIN_LENGTH = 12;

describe("自己参照がバッチ境界をまたいでも eraseTenant は全部消し切る（Issue #1207 / ADR 0383）", () => {
  it("superseded_by_id の鎖（挿入順が参照順と逆）を limit: 1 で消し切る", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const T = "erase-tenant-self-ref-chain";
    const ctx: Ctx = { tenantId: T };

    const baseInput = (i: number, supersededById: string | null): NewMemory => ({
      tenantId: T,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `本文 ${i}`,
      contentHash: `hash-self-ref-chain-${i}`,
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
      status: i > 0 ? "superseded" : "active",
      ...(supersededById !== null ? { supersededById: supersededById as never } : {}),
    });

    const ids: string[] = [];
    for (let i = 0; i < CHAIN_LENGTH; i++) {
      const memory = await memoryStore.createMemory(
        ctx,
        baseInput(i, i === 0 ? null : ids[i - 1]!),
      );
      ids.push(memory.id);
    }

    for (let i = 1; i < CHAIN_LENGTH; i++) {
      const memory = await memoryStore.get(ctx, ids[i]! as never);
      expect(memory?.supersededById).toBe(ids[i - 1]);
    }

    const deps = {
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };

    let outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 1 });
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(CHAIN_LENGTH * 3);
      outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 1 });
    }
    expect(outcome.kind).toBe("executed");

    const remaining = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [T],
    );
    expect(remaining.rows[0]!.n).toBe(0);
  }, 60_000);

  it("contested_with_id の相互参照（2件だけ、limit: 1）でも全部消し切る", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const T = "erase-tenant-self-ref-contested";
    const ctx: Ctx = { tenantId: T };

    const a = await memoryStore.createMemory(ctx, {
      tenantId: T,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文 A",
      contentHash: "hash-self-ref-contested-a",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const b = await memoryStore.createMemory(ctx, {
      tenantId: T,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文 B",
      contentHash: "hash-self-ref-contested-b",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const eventFor = (memoryId: string) => ({
      tenantId: T,
      memoryId: memoryId as never,
      kind: "updated" as const,
      at: new Date(),
      actor: { type: "system" as const },
      meta: {},
    });
    await memoryStore.markContestedPair?.(
      ctx,
      { id: a.id, event: eventFor(a.id) as never },
      { id: b.id, event: eventFor(b.id) as never },
    );

    const deps = {
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    let outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 1 });
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 1 });
    }
    expect(outcome.kind).toBe("executed");

    const remaining = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [T],
    );
    expect(remaining.rows[0]!.n).toBe(0);
  }, 60_000);
});
