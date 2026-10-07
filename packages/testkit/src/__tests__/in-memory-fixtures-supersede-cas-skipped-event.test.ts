import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";

/**
 * `supersedeWithNewMemories`: CAS に弾かれた対象は例外にせず `conflicted` に積む（`MemoryStore.supersedeWithNewMemories` の TSDoc）。
 * その対象のイベントは書かれないので、書けない値（`kind`・`at`・`actor` の NUL・`meta` の BigInt・`sizeBeforeBytes`）でも確かめない
 * （Postgres は弾かれた対象のイベントを見ない）。CAS を通る対象は、状態を書き換える前に投げる。
 */

const ctx: Ctx = { tenantId: "supersede-cas-skipped-event" };
const T = ctx.tenantId;

const BAD_EVENTS: Array<[string, Partial<NewMemoryEvent>]> = [
  ["kind が列挙に無い", { kind: "bogus" as never }],
  ["at が Invalid Date", { at: new Date(Number.NaN) }],
  ["actor に NUL", { actor: { type: "system", note: "a\u0000b" } as never }],
  ["meta に BigInt", { meta: { n: 1n } as never }],
  ["sizeBeforeBytes が整数でない", { sizeBeforeBytes: 1.5 }],
];

async function setup() {
  const store = new InMemoryMemoryStore();
  const old = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: T, contentHash: "old" }),
  );
  const input = buildNewMemoryFixture({ tenantId: T, contentHash: "new" });
  const event = (over: Partial<NewMemoryEvent>) =>
    buildNewMemoryEventFixture({ tenantId: T, memoryId: old.id, kind: "superseded", ...over });
  return { store, old, input, event };
}

describe("InMemoryMemoryStore.supersedeWithNewMemories: CAS に弾かれた対象のイベントは確かめない", () => {
  it.each(BAD_EVENTS)(
    "%s でも、CAS に弾かれた対象は conflicted に積み、イベントを書かない",
    async (_name, bad) => {
      const { store, old, input, event } = await setup();
      const result = await store.supersedeWithNewMemories(
        ctx,
        [{ input, jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, expectedStatus: "archived", event: event(bad) }],
      );
      expect(result.conflicted).toEqual([{ id: old.id, observedStatus: "active" }]);
      expect(result.superseded).toEqual([]);
      expect(store.events).toHaveLength(0);
      expect((await store.getMany(ctx, [old.id]))[0]?.status).toBe("active");
    },
  );

  it.each(BAD_EVENTS)("%s なら、CAS を通る対象は投げ、何も書かない（対照）", async (_name, bad) => {
    const { store, old, input, event } = await setup();
    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [{ input, jobKinds: ["embed"] }],
        [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(bad) }],
      ),
    ).rejects.toThrow();
    expect(store.events).toHaveLength(0);
    expect(store.outboxJobs).toHaveLength(0);
    expect((await store.getMany(ctx, [old.id]))[0]?.status).toBe("active");
  });

  // 再確かめ（2026-10-07 マージ分、#1871）。`expectedStatus` を付けない対象は CAS が常に通る側（CAS を通る対象）で、
  // 悪いイベントなら、expectedStatus を付けた対象と同じく、状態を書き換える前に投げる。
  it.each(BAD_EVENTS)(
    "%s なら、expectedStatus を付けない対象（CAS が常に通る）も投げ、何も書かない",
    async (_name, bad) => {
      const { store, old, input, event } = await setup();
      await expect(
        store.supersedeWithNewMemories(
          ctx,
          [{ input, jobKinds: ["embed"] }],
          [{ id: old.id, supersededByIndex: 0, event: event(bad) }],
        ),
      ).rejects.toThrow();
      expect(store.events).toHaveLength(0);
      expect(store.outboxJobs).toHaveLength(0);
      expect((await store.getMany(ctx, [old.id]))[0]?.status).toBe("active");
    },
  );

  it("1つ目が CAS に弾かれ（悪いイベント）、2つ目が通る（正しいイベント）なら、書くのは2つ目のイベントだけ", async () => {
    const { store, old, input, event } = await setup();
    const other = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: T, contentHash: "other" }),
    );
    const result = await store.supersedeWithNewMemories(
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
    expect(store.events).toHaveLength(1);
  });
});
