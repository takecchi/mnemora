import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
 *
 * `memories.superseded_by_id`/`contested_with_id` は `memories(id)` への自己参照 FK
 * （`ON DELETE` 指定なし＝既定の `NO ACTION`）。`limit` で区切ったバッチをまたいで
 * 自己参照が残っていると（このバッチで削除する行を、まだ削除していない別バッチの行が
 * 指している場合）、参照される側（親）を先に消そうとした時点で FK 違反になる。
 *
 * `PostgresMemoryStore.eraseTenant` は、`memories` を削除する**前**に、このテナントの
 * `superseded_by_id`/`contested_with_id` を丸ごと（`limit` に関わらず全件）`NULL` へ
 * 書き換えることでこれを防ぐ（`memory-store.ts` の `eraseTenantBody` 参照）。
 *
 * この歯は、**わざと参照先が別バッチになるデータを作り**（`limit` を小さくする）、
 * それでも全部消し切れることを確かめる。
 *
 * ## データの作り方（自然な heap scan の順序に賭けない）
 *
 * `mem[0]`（先頭、誰も指さない）→ `mem[1].supersededById = mem[0].id` →
 * `mem[2].supersededById = mem[1].id` → … という鎖を作る。挿入順は `mem[0]`
 * が最初——`limit` で区切った削除が挿入順（多くの環境で素の heap scan に近い順序）で
 * 進むと仮定すると、`mem[0]`（親、`mem[1]` から参照されている）が最初のバッチで
 * 削除されようとし、`NULL` 化が無ければ即座に FK 違反になる。**この仮定が外れて
 * 別の順序で消えたとしても、鎖の途中のどこかで同じ形の「親が先に消される」瞬間が
 * 高い確率で起きる**（鎖の要素数ぶん、機会がある）——`limit: 1` で全要素数ぶん
 * 呼び出すことで、この機会を最大化してある。
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

    // 前提の確認: 鎖が実際に張られている（先頭以外は非 null の superseded_by_id を持つ）。
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
      // CHAIN_LENGTH 回の呼び出しで消し切れるはず——大きく超えたら無限ループを疑う。
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
    // `markContestedPair?` を直呼びして、相互参照 + status='contested' を作る
    // （`createMemory` の時点では相手がまだ確定していない、という通常の作られ方に揃える）。
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
