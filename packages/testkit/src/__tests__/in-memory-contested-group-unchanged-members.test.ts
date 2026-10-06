import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * ADR 0431 の確かめ直し（Issue #1734、PR #1537）で足した歯。`markContestedGroup` が `updated` を積まないのは、
 * 呼び出し時点で「既に contested で `contestedWithId` が無い」メンバー（既存の群の一員）だけ。
 * 対の片割れ（contested で `contestedWithId` がある）は、群へ吸収されて状態が変わるので、積む。
 * Postgres の同じ歯は `contested-group-event-growth.postgres.test.ts`（testkit の InMemory と core の Fake は無かった）。
 */
const ctx: Ctx = { tenantId: "contested-group-unchanged-members" };

function event(memoryId: MemoryId): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: { reason: "contested" },
  };
}

const STORES: Array<[string, () => MemoryStore]> = [
  ["testkit の InMemory", () => new InMemoryMemoryStore()],
  ["core の Fake", () => createFakeRuntimeStores().memoryStore as unknown as MemoryStore],
];

describe.each(STORES)(
  "markContestedGroup: 状態の変わらないメンバーには updated を積まない（%s）",
  (_name, make) => {
    it("既に群の一員は積まない。active と、対の片割れ（contestedWithId あり）は積む", async () => {
      const store = make();
      const create = async (tag: string) =>
        (
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              contentHash: `h-${tag}`,
              content: tag,
            }),
          )
        ).id;
      const g0 = await create("g0");
      const g1 = await create("g1");
      const g2 = await create("g2");
      const p1 = await create("p1");
      const p2 = await create("p2");
      const fresh = await create("fresh");
      await store.markContestedGroup!(
        ctx,
        [g0, g1, g2].map((id) => ({ id, event: event(id) })),
      );
      await store.markContestedPair!(
        ctx,
        { id: p1, event: event(p1) },
        { id: p2, event: event(p2) },
      );

      const { events } = await store.markContestedGroup!(
        ctx,
        [g0, p1, p2, fresh].map((id) => ({ id, event: event(id) })),
      );

      expect(events.map((e) => e.memoryId).sort()).toEqual([p1, p2, fresh].sort());
    });
  },
);
