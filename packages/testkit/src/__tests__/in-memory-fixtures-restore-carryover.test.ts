// Issue #809: `resolveContestedPair`（supersede 分岐）・`restoreSupersededBy`・
// `updateStatusWithEvent(kind='restored')` が、`status`/`contestedWithId`/
// `supersededById`/`updatedAt` 以外の付随データ（`subjectId`・`tags`・`attributes`・
// `provenance`・`validFrom`/`validUntil`・`occurredAt`・`strength`・`halfLifeHours`・
// `decayFloorAt`・`embeddingStatus` 等）に触れないことを、`InMemoryMemoryStore` に
// 対して実測で確認する。
//
// **`memory-store-conformance.ts`（適合テスト一式）には足さない**（Issue #809 の方針。
// 外部 adapter 実装者にまで要求を増やすため）。ここは `packages/testkit` 内だけで
// 完結する、Fake を直接呼ぶ回帰テスト——`in-memory-fixtures-resolve-orphaned-contested.test.ts`
// 冒頭の同じ方針を踏襲する。Postgres 側は
// `packages/postgres/src/__tests__/restore-carryover.postgres.test.ts`。

import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingStatus, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function richOverrides(contentHash: string) {
  return {
    tenantId: ctx.tenantId,
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
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested" },
  };
}

function resolveEvent(memoryId: MemoryId, kind: "updated" | "superseded"): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
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
    tenantId: ctx.tenantId,
    memoryId,
    kind: "restored",
    actor: { type: "system" },
    digestSnapshot: digest,
    sizeBeforeBytes: null,
    meta: {},
  };
}

describe("InMemoryMemoryStore — restore/resolve 系の付随データ保全（Issue #809）", () => {
  // ⚠ `InMemoryMemoryStore.get`/`createMemory` は Postgres と違い、Map に入れた
  // *まさにその* `Memory` オブジェクトをそのまま返す（行を毎回パースし直す postgres 側
  // と違い、コピーを取らない——`get()`/`createMemory()` の実装参照）。そのため、
  // 変異対象のメソッドが対象を直接書き換えると、`a`/`b`/`target`/`memory` のような
  // 「操作前に受け取った変数」も**同じ参照**なので一緒に書き換わってしまい、
  // 「操作後の値」対「操作前に受け取った変数」を比較しても常に一致してしまう
  // （変異があっても赤くならない、偽陰性）。
  // ⟹ **`ancillary()` のスナップショットは、変異対象の呼び出しより前に取る**——
  // `ancillary()` は各欄を `Date` ではなく `number`（`getTime()`）・プリミティブへ
  // 展開して新しいプレーンオブジェクトを返すため、後から元の `Memory` オブジェクトが
  // 書き換わっても、先に取ったスナップショット（プリミティブのコピー）は影響を受けない。
  // これで Postgres 側と同じ強さの検査になる（実際に変異試験で確認済み——このファイルの
  // 冒頭コメント参照）。

  it("resolveContestedPair(supersede) は付随データを、status/contestedWithId/supersededById/updatedAt 以外そのまま保つ（勝者・敗者とも）", async () => {
    const store = new InMemoryMemoryStore();

    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture(richOverrides("resolve-contested-carryover-a")),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture(richOverrides("resolve-contested-carryover-b")),
    );
    const expectedA = ancillary(a);
    const expectedB = ancillary(b);

    await store.markContestedPair(
      ctx,
      { id: a.id, event: markEvent(a.id) },
      { id: b.id, event: markEvent(b.id) },
    );

    const result = await store.resolveContestedPair(
      ctx,
      { id: a.id, status: "active", event: resolveEvent(a.id, "updated") },
      {
        id: b.id,
        status: "superseded",
        supersededById: a.id,
        event: resolveEvent(b.id, "superseded"),
      },
    );

    expect(ancillary(result.first)).toEqual(expectedA);
    expect(ancillary(result.second)).toEqual(expectedB);

    const afterA = await store.get(ctx, a.id);
    const afterB = await store.get(ctx, b.id);
    expect(ancillary(afterA!)).toEqual(expectedA);
    expect(ancillary(afterB!)).toEqual(expectedB);
  });

  it("updateStatusWithEvent の kind='restored' は付随データを、status/updatedAt 以外そのまま保つ", async () => {
    const store = new InMemoryMemoryStore();

    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        ...richOverrides("restore-archived-carryover"),
        status: "archived",
      }),
    );
    const expected = ancillary(memory);

    const { memory: restored } = await store.updateStatusWithEvent(
      ctx,
      memory.id,
      "active",
      { expectedStatus: "archived" },
      restoredEvent(memory.id, memory.digest),
    );

    expect(ancillary(restored)).toEqual(expected);
    const reread = await store.get(ctx, memory.id);
    expect(ancillary(reread!)).toEqual(expected);
  });

  it("restoreSupersededBy は付随データを、status/supersededById/updatedAt 以外そのまま保つ", async () => {
    const store = new InMemoryMemoryStore();

    const anchor = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
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
    const expected = ancillary(target);

    const result = await store.restoreSupersededBy(ctx, anchor.id, {
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(result.restored.map((m) => m.id)).toEqual([target.id]);

    expect(ancillary(result.restored[0]!)).toEqual(expected);
    const after = await store.get(ctx, target.id);
    expect(ancillary(after!)).toEqual(expected);
  });
});
