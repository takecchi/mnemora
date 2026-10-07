import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-supersede-malformed-position" };
const MISSING = "00000000-0000-4000-8000-000000000001";

const newMemory = (over: Partial<NewMemory> = {}): NewMemory => ({
  tenantId: ctx.tenantId,
  subjectId: null,
  sourceObservationId: null,
  extractorVersion: null,
  content: "本文",
  contentHash: "hash",
  digest: "digest",
  digestSource: "llm",
  provenance: { kind: "imported", batchId: "fixture" },
  tags: [],
  occurredAt: null,
  recordedAt: new Date("2020-01-01T00:00:00.000Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
  decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
  embeddingStatus: "pending",
  ...over,
});

describe("FakeMemoryStore.supersedeWithNewMemories: 壊れた news は、どの位置でも、存在しない対象の not found より先に断られる", () => {
  it.each([0, 1, 2])("壊れた news が %s 番目", async (broken) => {
    const stores = createFakeRuntimeStores();
    const news = [0, 1, 2].map((i) => ({
      input: newMemory({ contentHash: `n${i}`, ...(i === broken ? { digest: "" } : {}) }),
      jobKinds: [] as never[],
    }));
    const error = await stores.memoryStore.supersedeWithNewMemories!(ctx, news, [
      {
        id: MISSING as never,
        supersededByIndex: 0,
        event: {
          tenantId: ctx.tenantId,
          memoryId: MISSING as never,
          kind: "superseded",
          actor: { type: "system" },
          digestSnapshot: "d",
          sizeBeforeBytes: null,
          meta: { reason: "test" },
        },
      },
    ]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(error)).toMatch(/digest is malformed/);
    expect(String(error)).not.toMatch(/not found/);
  });
});
