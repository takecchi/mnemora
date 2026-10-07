import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `supersedeWithNewMemories`: CAS に弾かれた対象は例外にせず `conflicted` に積む（`MemoryStore.supersedeWithNewMemories` の TSDoc）。
 * その対象のイベントは書かれないので、書けない値（`kind`・`at`・`actor` の NUL・`meta` の BigInt・`sizeBeforeBytes`）でも確かめない
 * （Postgres は弾かれた対象のイベントを見ない）。CAS を通る対象は、状態を書き換える前に投げる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

const newMemory = (contentHash: string): NewMemory => ({
  tenantId: ctx.tenantId,
  subjectId: null,
  sourceObservationId: null,
  extractorVersion: null,
  content: "本文",
  contentHash,
  digest: "digest",
  digestSource: "llm",
  provenance: { kind: "imported", batchId: "fixture" },
  tags: [],
  occurredAt: null,
  recordedAt: new Date("2026-01-01T00:00:00.000Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
  decayFloorAt: new Date("2027-01-01T00:00:00.000Z"),
  embeddingStatus: "pending",
});

const BAD_EVENTS: Array<[string, Partial<NewMemoryEvent>]> = [
  ["kind が列挙に無い", { kind: "bogus" as never }],
  ["at が Invalid Date", { at: new Date(Number.NaN) }],
  ["actor に NUL", { actor: { type: "system", note: "a\u0000b" } as never }],
  ["meta に BigInt", { meta: { n: 1n } as never }],
  ["sizeBeforeBytes が整数でない", { sizeBeforeBytes: 1.5 }],
];

async function setup() {
  const stores = createFakeRuntimeStores();
  const store = stores.memoryStore;
  const old = await store.createMemory(ctx, newMemory("old"));
  const event = (over: Partial<NewMemoryEvent>): NewMemoryEvent => ({
    tenantId: ctx.tenantId,
    memoryId: old.id,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...over,
  });
  const backing = (store as unknown as { backing: { events: unknown[]; outboxJobs: unknown[] } })
    .backing;
  return { store, old, input: newMemory("new"), event, backing };
}

describe("FakeMemoryStore.supersedeWithNewMemories: CAS に弾かれた対象のイベントは確かめない", () => {
  it.each(BAD_EVENTS)(
    "%s でも、CAS に弾かれた対象は conflicted に積み、イベントを書かない",
    async (_name, bad) => {
      const { store, old, input, event, backing } = await setup();
      const result = await store.supersedeWithNewMemories!(
        ctx,
        [{ input, jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, expectedStatus: "archived", event: event(bad) }],
      );
      expect(result.conflicted).toEqual([{ id: old.id, observedStatus: "active" }]);
      expect(result.superseded).toEqual([]);
      expect(backing.events).toHaveLength(0);
      expect((await store.getMany(ctx, [old.id]))[0]?.status).toBe("active");
    },
  );

  it.each(BAD_EVENTS)("%s なら、CAS を通る対象は投げ、何も書かない（対照）", async (_name, bad) => {
    const { store, old, input, event, backing } = await setup();
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [{ input, jobKinds: ["embed"] }],
        [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(bad) }],
      ),
    ).rejects.toThrow();
    expect(backing.events).toHaveLength(0);
    expect(backing.outboxJobs).toHaveLength(0);
    expect((await store.getMany(ctx, [old.id]))[0]?.status).toBe("active");
  });

  // 再確かめ（2026-10-07 マージ分、#1871）。`expectedStatus` を付けない対象は CAS が常に通る側（CAS を通る対象）で、
  // 悪いイベントなら、expectedStatus を付けた対象と同じく、状態を書き換える前に投げる。
  it.each(BAD_EVENTS)(
    "%s なら、expectedStatus を付けない対象（CAS が常に通る）も投げ、何も書かない",
    async (_name, bad) => {
      const { store, old, input, event, backing } = await setup();
      await expect(
        store.supersedeWithNewMemories!(
          ctx,
          [{ input, jobKinds: ["embed"] }],
          [{ id: old.id, supersededByIndex: 0, event: event(bad) }],
        ),
      ).rejects.toThrow();
      expect(backing.events).toHaveLength(0);
      expect(backing.outboxJobs).toHaveLength(0);
      expect((await store.getMany(ctx, [old.id]))[0]?.status).toBe("active");
    },
  );

  it("1つ目が CAS に弾かれ（悪いイベント）、2つ目が通る（正しいイベント）なら、書くのは2つ目のイベントだけ", async () => {
    const { store, old, input, event, backing } = await setup();
    const other = await store.createMemory(ctx, newMemory("other"));
    const result = await store.supersedeWithNewMemories!(
      ctx,
      [{ input, jobKinds: [] }],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          expectedStatus: "archived",
          event: event({ kind: "bogus" as never }),
        },
        { id: other.id, supersededByIndex: 0, event: event({ memoryId: other.id }) },
      ],
    );
    expect(result.conflicted).toHaveLength(1);
    expect(result.superseded).toHaveLength(1);
    expect(backing.events).toHaveLength(1);
  });
});
