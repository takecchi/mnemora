import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "create-idempotent-rejects" };

const CASES: Array<[string, Partial<NewMemory>, RegExp]> = [
  ["列挙に無い status", { status: "bogus" as never }, /^memories\.status must be one of /],
  ["content に NUL", { content: "a\u0000b" }, /content must not contain NUL characters/],
  ["recordedAt が Invalid Date", { recordedAt: new Date(NaN) }, /recordedAt must be a valid Date/],
  ["strength が値域の外", { strength: 5 }, /strength out of range/],
  [
    "halfLifeHours が float4 に収まらない",
    { halfLifeHours: 1e300 },
    /does not fit in a Postgres "real"/,
  ],
];

describe("testkit の fixture は、冪等の既存の行が在っても書けない値を拒む", () => {
  it.each(CASES)("%s", async (_label, override, message) => {
    const store = new InMemoryMemoryStore();
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const valid = buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "idempotent",
      sourceObservationId: observation.id,
      extractorVersion: "v1",
    });
    const existing = await store.createMemory(ctx, valid);

    await expect(store.createMemory(ctx, { ...valid, ...override })).rejects.toThrow(message);
    await expect(
      store.createMemoryWithOutbox(ctx, { ...valid, ...override }, ["embed"]),
    ).rejects.toThrow(message);

    expect(await store.get(ctx, existing.id)).toEqual(existing);
    expect(store.outboxJobs).toHaveLength(0);
  });
});
