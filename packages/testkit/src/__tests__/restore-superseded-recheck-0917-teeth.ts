import { describe, expect, it } from "vitest";
import type { Ctx, MemoryEvent, MemoryId, MemoryStore, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";

export interface RestoreSupersededRecheckKit {
  store: MemoryStore;
  listEvents(ctx: Ctx, memoryId?: MemoryId): Promise<MemoryEvent[]>;
}

const ctx: Ctx = { tenantId: "recheck-0917-tenant" };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const AT = new Date("2026-06-01T00:00:00.000Z");

let n = 0;
function mem(overrides: Partial<NewMemory> = {}): NewMemory {
  n += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `recheck-0917-${n}-${Math.random()}`,
    ...overrides,
  });
}

export function describeRestoreSupersededRecheckTeeth(
  label: string,
  makeKit: () => Promise<RestoreSupersededRecheckKit>,
): void {
  describe(`${label} — restoreSupersededBy / previewRestoreSupersededBy の選び方と読み取り専用`, () => {
    it("previewRestoreSupersededBy は別の置き換えた側の群を候補に含めない", async () => {
      const { store } = await makeKit();
      const anchorA = await store.createMemory(ctx, mem());
      const anchorB = await store.createMemory(ctx, mem());
      const a = await store.createMemory(
        ctx,
        mem({ status: "superseded", supersededById: anchorA.id }),
      );
      await store.createMemory(ctx, mem({ status: "superseded", supersededById: anchorB.id }));

      const preview = await store.previewRestoreSupersededBy!(ctx, anchorA.id);

      expect(preview.candidates.map((c) => c.memoryId)).toEqual([a.id]);
    });

    it("supersededReason は kind='superseded' の直近のイベントから取り、後から積まれた別 kind のイベントの reason は読まない", async () => {
      const { store } = await makeKit();
      const anchor = await store.createMemory(ctx, mem());
      const m = await store.createMemory(ctx, mem());
      await store.updateStatusWithEvent(
        ctx,
        m.id,
        "superseded",
        { supersededById: anchor.id, expectedStatus: "active" },
        {
          tenantId: ctx.tenantId,
          memoryId: m.id,
          kind: "superseded",
          at: new Date("2026-01-01T00:00:00.000Z"),
          actor: { type: "system" },
          digestSnapshot: m.digest,
          meta: { reason: "consolidated" },
        },
      );
      await store.updateStatusWithEvent(
        ctx,
        m.id,
        "superseded",
        { supersededById: anchor.id, expectedStatus: "superseded" },
        {
          tenantId: ctx.tenantId,
          memoryId: m.id,
          kind: "updated",
          at: new Date("2026-02-01T00:00:00.000Z"),
          actor: { type: "system" },
          digestSnapshot: m.digest,
          meta: { reason: "not-a-supersede" },
        },
      );

      const preview = await store.previewRestoreSupersededBy!(ctx, anchor.id);

      expect(preview.candidates).toEqual([{ memoryId: m.id, supersededReason: "consolidated" }]);
    });

    it("previewRestoreSupersededBy は候補にも置き換えた側にも書き込まない（updatedAt を含む）", async () => {
      const { store, listEvents } = await makeKit();
      const anchor = await store.createMemory(ctx, mem());
      const s = await store.createMemory(
        ctx,
        mem({ status: "superseded", supersededById: anchor.id }),
      );
      const before = [await store.get(ctx, anchor.id), await store.get(ctx, s.id)];
      const eventsBefore = (await listEvents(ctx)).length;
      await wait(5);

      await store.previewRestoreSupersededBy!(ctx, anchor.id);

      expect([await store.get(ctx, anchor.id), await store.get(ctx, s.id)]).toEqual(before);
      expect(await listEvents(ctx)).toHaveLength(eventsBefore);
    });

    it("restoreSupersededBy は置き換えた側の行（updatedAt を含む）に触れず、置き換えた側のイベントも積まない", async () => {
      const { store, listEvents } = await makeKit();
      const anchor = await store.createMemory(ctx, mem());
      await store.createMemory(ctx, mem({ status: "superseded", supersededById: anchor.id }));
      const before = await store.get(ctx, anchor.id);
      const anchorEventsBefore = await listEvents(ctx, anchor.id);
      await wait(5);

      const result = await store.restoreSupersededBy!(ctx, anchor.id, { at: AT });

      expect(result.restored).toHaveLength(1);
      expect(await store.get(ctx, anchor.id)).toEqual(before);
      expect(await listEvents(ctx, anchor.id)).toEqual(anchorEventsBefore);
    });
  });
}
