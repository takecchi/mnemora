import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "empty-string-references" };

describe("testkit の fixture は空文字の参照・冪等の鍵を「値が在る」として扱う", () => {
  it.each([
    [
      "sourceObservationId",
      { sourceObservationId: "" },
      /^InMemoryMemoryStore: observation not found for tenant: $/,
    ],
    [
      "supersededById",
      { status: "superseded" as const, supersededById: "" },
      /^InMemoryMemoryStore: memory not found for tenant: $/,
    ],
    [
      "contestedWithId",
      { status: "contested" as const, contestedWithId: "" },
      /^InMemoryMemoryStore: memory not found for tenant: $/,
    ],
  ])("createMemory: 空文字の %s を拒み、何も書かない", async (field, override, message) => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `empty-${field}`,
          ...override,
        }),
        ["embed"],
      ),
    ).rejects.toThrow(message);
    expect(store.outboxJobs).toHaveLength(0);
  });

  it("createObservation: externalId が空文字なら、2回目は既存の行を返し、ジョブを積まない", async () => {
    const store = new InMemoryMemoryStore();
    const input = buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "" });
    const first = await store.createObservation(ctx, input);
    const second = await store.createObservationWithOutbox(ctx, input, ["extract"]);
    expect(second).toEqual({ observation: first, created: false, jobs: [] });
    expect(store.outboxJobs).toHaveLength(0);
  });
});
