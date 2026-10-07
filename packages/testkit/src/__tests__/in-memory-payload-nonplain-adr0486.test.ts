import { describe, expect, it } from "vitest";
import type { Ctx, NewObservation } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function observation(payload: unknown): NewObservation {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    externalId: null,
    kind: "event",
    payload,
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    attributes: {},
  };
}

describe("ADR 0486: プレーンでない値は structuredClone に任せる（潰さない）", () => {
  it("Map・Set・型付き配列は、種類を保って読み戻る", async () => {
    const store = new InMemoryMemoryStore();
    const payload = {
      m: new Map([["k", 1]]),
      s: new Set([1, 2]),
      t: new Uint8Array([1, 2, 3]),
    };
    const created = await store.createObservation(ctx, observation(payload));
    const read = (await store.getObservation(ctx, created.id))!.payload as typeof payload;
    expect(read.m).toBeInstanceOf(Map);
    expect([...read.m]).toEqual([["k", 1]]);
    expect(read.s).toBeInstanceOf(Set);
    expect([...read.s]).toEqual([1, 2]);
    expect(read.t).toBeInstanceOf(Uint8Array);
    expect([...read.t]).toEqual([1, 2, 3]);
  });

  it("data そのものが Map のときも潰れない", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.createObservation(ctx, observation(new Map([["a", 1]])));
    const read = (await store.getObservation(ctx, created.id))!.payload;
    expect(read).toBeInstanceOf(Map);
  });
});
