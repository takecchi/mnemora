import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

/**
 * 空文字の参照・冪等の鍵を、testkit の fixture も Postgres と同じく「値が在る」として扱う。
 * 2実装を並べた歯は `packages/postgres/src/__tests__/empty-string-references.postgres.test.ts`（DB が要る）。
 * ここは DB 無しで走る側の歯で、文面と「何も書かない」を縛る。
 */

const ctx: Ctx = { tenantId: "empty-string-references" };

describe("testkit の fixture は空文字の参照・冪等の鍵を「値が在る」として扱う", () => {
  it.each([
    [
      "sourceObservationId",
      { sourceObservationId: "" },
      /^InMemoryMemoryStore: source observation not found: $/,
    ],
    [
      "supersededById",
      { status: "superseded" as const, supersededById: "" },
      /^InMemoryMemoryStore: superseded-by memory not found: $/,
    ],
    [
      "contestedWithId",
      { status: "contested" as const, contestedWithId: "" },
      /^InMemoryMemoryStore: contested-with memory not found: $/,
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
