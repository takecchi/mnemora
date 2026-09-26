import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingStatus, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #809: `resolveContestedPair`（supersede 分岐）・`restoreSupersededBy`・
 * `updateStatusWithEvent(kind='restored')` が、`status`/`contestedWithId`/
 * `supersededById`/`updatedAt` 以外の付随データ（`subjectId`・`tags`・`attributes`・
 * `provenance`・`validFrom`/`validUntil`・`occurredAt`・`strength`・`halfLifeHours`・
 * `decayFloorAt`・`embeddingStatus` 等）に触れないことを、**本物の Postgres に対して**
 * 実測で確認する。
 *
 * **この3本は元々 `packages/testkit/src/memory-store-conformance.ts`（適合テスト一式）
 * に足す案があったが、Issue #809 の方針で見送った**——適合テストに足すと、外部
 * adapter 実装者にまで「この3本の付随データ保全」を要求することになるため。
 * 代わりに、この事実を実際に確かめたい対象（Postgres・testkit の in-memory）ごとに
 * 専用のテストとして持つ。in-memory 側は
 * `packages/testkit/src/__tests__/in-memory-fixtures-restore-carryover.test.ts`。
 *
 * `restoreSupersededBy` の UPDATE 文（`packages/postgres/src/memory-store.ts` の
 * `SET status = 'active', superseded_by_id = NULL, updated_at = now()`）に
 * `subject_id = NULL, strength = 1` を混ぜる変異で、この歯が実際に赤くなることを
 * 確認済み（確認後 revert。手順は `AGENTS.md` の変異試験節）。
 */

const TENANT = "restore-carryover-tenant";

function richOverrides(contentHash: string) {
  return {
    tenantId: TENANT,
    contentHash,
    subjectId: "subject-carryover",
    tags: ["carryover-tag-1", "carryover-tag-2"],
    attributes: { scope: "team" },
    occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    validFrom: new Date("2026-01-15T00:00:00.000Z"),
    validUntil: new Date("2026-12-31T00:00:00.000Z"),
    strength: 0.42,
    halfLifeHours: 333,
  };
}

interface AncillaryShape {
  subjectId?: string | null;
  tags: string[];
  attributes?: Record<string, unknown>;
  provenance: unknown;
  occurredAt?: Date | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  strength: number;
  halfLifeHours: number;
  decayFloorAt: Date;
  embeddingStatus: EmbeddingStatus;
  content: string;
  contentHash: string;
  digest: string;
  digestSource: string;
  recordedAt: Date;
}

function ancillary(m: AncillaryShape) {
  return {
    subjectId: m.subjectId ?? null,
    tags: m.tags,
    attributes: m.attributes,
    provenance: m.provenance,
    occurredAt: m.occurredAt?.getTime() ?? null,
    validFrom: m.validFrom?.getTime() ?? null,
    validUntil: m.validUntil?.getTime() ?? null,
    strength: m.strength,
    halfLifeHours: m.halfLifeHours,
    decayFloorAt: m.decayFloorAt.getTime(),
    embeddingStatus: m.embeddingStatus,
    content: m.content,
    contentHash: m.contentHash,
    digest: m.digest,
    digestSource: m.digestSource,
    recordedAt: m.recordedAt.getTime(),
  };
}

function markEvent(memoryId: MemoryId): NewMemoryEvent {
  return {
    tenantId: TENANT,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested" },
  };
}

function resolveEvent(memoryId: MemoryId, kind: "updated" | "superseded"): NewMemoryEvent {
  return {
    tenantId: TENANT,
    memoryId,
    kind,
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "contested_resolved" },
  };
}

function restoredEvent(memoryId: MemoryId, digest: string): NewMemoryEvent {
  return {
    tenantId: TENANT,
    memoryId,
    kind: "restored",
    actor: { type: "system" },
    digestSnapshot: digest,
    sizeBeforeBytes: null,
    meta: {},
  };
}

describe("PostgresMemoryStore — restore/resolve 系の付随データ保全（Issue #809）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("resolveContestedPair(supersede) は付随データを、status/contestedWithId/supersededById/updatedAt 以外そのまま保つ（勝者・敗者とも）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture(richOverrides("resolve-contested-carryover-a")),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture(richOverrides("resolve-contested-carryover-b")),
    );
    await store.markContestedPair!(
      ctx,
      { id: a.id, event: markEvent(a.id) },
      { id: b.id, event: markEvent(b.id) },
    );

    const result = await store.resolveContestedPair!(
      ctx,
      { id: a.id, status: "active", event: resolveEvent(a.id, "updated") },
      {
        id: b.id,
        status: "superseded",
        supersededById: a.id,
        event: resolveEvent(b.id, "superseded"),
      },
    );

    expect(ancillary(result.first)).toEqual(ancillary(a));
    expect(ancillary(result.second)).toEqual(ancillary(b));

    const afterA = await store.get(ctx, a.id);
    const afterB = await store.get(ctx, b.id);
    expect(ancillary(afterA!)).toEqual(ancillary(a));
    expect(ancillary(afterB!)).toEqual(ancillary(b));
  });

  it("updateStatusWithEvent の kind='restored' は付随データを、status/updatedAt 以外そのまま保つ", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        ...richOverrides("restore-archived-carryover"),
        status: "archived",
      }),
    );

    const { memory: restored } = await store.updateStatusWithEvent(
      ctx,
      memory.id,
      "active",
      { expectedStatus: "archived" },
      restoredEvent(memory.id, memory.digest),
    );

    expect(ancillary(restored)).toEqual(ancillary(memory));
    const reread = await store.get(ctx, memory.id);
    expect(ancillary(reread!)).toEqual(ancillary(memory));
  });

  it("restoreSupersededBy は付随データを、status/supersededById/updatedAt 以外そのまま保つ", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const anchor = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "restore-superseded-carryover-anchor",
      }),
    );
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        ...richOverrides("restore-superseded-carryover-target"),
        status: "superseded",
        supersededById: anchor.id,
      }),
    );

    const result = await store.restoreSupersededBy!(ctx, anchor.id, {
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(result.restored.map((m) => m.id)).toEqual([target.id]);

    expect(ancillary(result.restored[0]!)).toEqual(ancillary(target));
    const after = await store.get(ctx, target.id);
    expect(ancillary(after!)).toEqual(ancillary(target));
  });
});
