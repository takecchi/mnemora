import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * PR #1762（ADR 0640）の約束: `assertWrittenTimestamptzFloor` は**下限だけ**を見る。Invalid Date は断らない（別の検査が在る）。
 * 「Invalid Date の文面は変わらない」。PR の歯は、Invalid Date の message を `reinforce`・`createMemory`・`EventStore.append` の3口でしか見ていなかった。
 * 下限の検査が Invalid Date も `RangeError` で断る変異（`!(t >= MIN)`）は、その3口では Invalid Date の検査が先に走るので緑のまま残る。
 * 下限の検査が Invalid Date の検査より前に在る口（`purgeMemory`）で、Invalid Date が従来の `Error`（文面は変わらない）のまま断られ、
 * `RangeError` にならないことを縛る。
 */
const ctx: Ctx = { tenantId: "in-memory-floor-leaves-invalid-date" };

describe("下限の検査は Invalid Date を RangeError にしない（Invalid Date の検査が後に在る口）", () => {
  it("purgeMemory の event.at が Invalid Date: 従来の Error（valid Date の文面）で、RangeError ではない", async () => {
    const store = new InMemoryMemoryStore();
    const m = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    await store.updateStatus(ctx, m.id, "forgotten", {});
    const error = await store
      .purgeMemory(
        ctx,
        m.id,
        { content: "x", digest: "y" },
        buildNewMemoryEventFixture({
          tenantId: ctx.tenantId,
          memoryId: m.id,
          kind: "purged",
          at: new Date(Number.NaN),
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(
      "memory_events.at must be a valid Date (got Invalid Date)",
    );
  });
});
