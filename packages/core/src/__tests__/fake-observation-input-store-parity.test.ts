import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewObservation } from "../observation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-observation-input-parity" };
const other: Ctx = { tenantId: "fake-observation-input-parity-other" };
const INVALID = new Date(Number.NaN);

let sequence = 0;
function observation(over: Record<string, unknown> = {}): NewObservation {
  sequence += 1;
  return {
    tenantId: ctx.tenantId,
    kind: "utterance",
    payload: { text: "t" },
    externalId: `ext-${sequence}`,
    recordedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as NewObservation;
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;
const WRITES = [
  [
    "createObservation",
    (s: Stores, input: NewObservation) => s.memoryStore.createObservation(ctx, input),
  ],
  [
    "createObservationWithOutbox",
    async (s: Stores, input: NewObservation) =>
      (await s.memoryStore.createObservationWithOutbox(ctx, input, ["extract"])).observation,
  ],
] as const;

describe.each(WRITES)("FakeMemoryStore.%s", (_name, write) => {
  it.each(["recordedAt", "occurredAt", "validFrom", "validUntil"] as const)(
    "同じ externalId の既存の行が在っても、再送の %s が Invalid Date なら拒む",
    async (field) => {
      const stores = createFakeRuntimeStores();
      const first = observation();
      await write(stores, first);

      await expect(write(stores, { ...first, [field]: INVALID })).rejects.toThrow(
        new RegExp(`${field} must be a valid Date`),
      );
    },
  );

  it.each([
    ["kind が空文字", { kind: "" }],
    ["subjectId が空文字", { subjectId: "" }],
    ["externalId が空文字", { externalId: "" }],
    ["attributes の値が数", { attributes: { a: 1 } }],
  ])("%s は受け付ける", async (_label, over) => {
    const stores = createFakeRuntimeStores();

    await expect(write(stores, observation(over))).resolves.toMatchObject({
      tenantId: ctx.tenantId,
    });
  });

  it("tenantId が ctx と違っても、ctx のテナントとして書く", async () => {
    const stores = createFakeRuntimeStores();

    const written = await write(stores, observation({ tenantId: other.tenantId }));

    expect(written.tenantId).toBe(ctx.tenantId);
    expect((await stores.memoryStore.getObservation(ctx, written.id))?.tenantId).toBe(ctx.tenantId);
    await expect(stores.memoryStore.getObservation(other, written.id)).resolves.toBeNull();
  });
});
