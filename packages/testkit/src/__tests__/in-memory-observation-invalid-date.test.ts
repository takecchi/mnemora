import { describe, expect, it } from "vitest";
import type { Ctx, NewObservation } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewObservationFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "observation-invalid-date" };

describe("testkit の fixture は createObservation 系の Invalid Date を拒む", () => {
  for (const field of ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const) {
    it(`${field}: 新しい行も、externalId が同じ既存の行も拒み、outbox にも積まない`, async () => {
      const store = new InMemoryMemoryStore();
      const bad: Partial<NewObservation> = { [field]: new Date(Number.NaN) };
      const message = new RegExp(
        `^InMemoryMemoryStore: ${field} must be a valid Date \\(got Invalid Date\\)$`,
      );

      await expect(
        store.createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: ctx.tenantId, ...bad }),
        ),
      ).rejects.toThrow(message);

      const valid = buildNewObservationFixture({
        tenantId: ctx.tenantId,
        externalId: `ext-${field}`,
      });
      const existing = await store.createObservation(ctx, valid);
      await expect(
        store.createObservationWithOutbox(ctx, { ...valid, ...bad }, ["extract"]),
      ).rejects.toThrow(message);
      expect(await store.getObservation(ctx, existing.id)).toEqual(existing);
      expect(store.outboxJobs).toHaveLength(0);
    });
  }

  for (const field of ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const) {
    it(`${field}: 1970年より前の有効な日付は通り、同じ値で読み戻る（#1243。拒むのは Invalid Date だけ）`, async () => {
      const store = new InMemoryMemoryStore();
      const date = new Date("1969-12-31T00:00:00.000Z");
      const created = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, [field]: date }),
      );
      const read = await store.getObservation(ctx, created.id);
      expect(read?.[field]).toEqual(date);
    });
  }
});
