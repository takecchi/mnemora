import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * `MemoryEventKind` に無い kind のイベントを、testkit の fixture も Postgres と同じく拒む（Issue #1096）。
 * Postgres は CHECK 制約 `memory_events_kind_check` で拒み、1トランザクションで何も書かない。
 *
 * 2実装を並べた歯は `packages/postgres/src/__tests__/memory-events-kind-check.postgres.test.ts`
 * （DB が要る）。ここは DB 無しで走る側の歯である。
 */

const ctx: Ctx = { tenantId: "event-kind-check" };

function eventWithKind(memoryId: string, kind: string): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: kind as NewMemoryEvent["kind"],
    actor: { type: "system" },
    meta: {},
  };
}

describe("testkit の fixture は MemoryEventKind に無い kind を拒む", () => {
  it("InMemoryEventStore.append は拒み、何も書かない（文面は at の検査と同じ形）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-append" }),
    );

    await expect(eventStore.append(ctx, eventWithKind(m.id, "contested"))).rejects.toThrow(
      /^memory_events\.kind must be one of created, updated, .* \(got "contested"\)$/,
    );
    expect(memoryStore.events).toHaveLength(0);
  });

  it("updateStatusWithEvent・markContestedPair は拒み、状態を変えない", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-a" }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "kind-b" }),
    );

    await expect(
      store.updateStatusWithEvent(
        ctx,
        a.id,
        "forgotten",
        { expectedStatus: "active" },
        eventWithKind(a.id, "deleted"),
      ),
    ).rejects.toThrow(/memory_events\.kind must be one of/);
    await expect(
      store.markContestedPair(
        ctx,
        { id: a.id, event: eventWithKind(a.id, "updated") },
        { id: b.id, event: eventWithKind(b.id, "contested") },
      ),
    ).rejects.toThrow(/memory_events\.kind must be one of/);

    expect((await store.get(ctx, a.id))?.status).toBe("active");
    expect((await store.get(ctx, b.id))?.status).toBe("active");
    expect(store.events).toHaveLength(0);
  });
});
