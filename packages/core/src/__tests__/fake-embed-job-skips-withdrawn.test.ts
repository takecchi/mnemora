import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0541: forget・purge した記憶の本文を、埋め込みジョブ（`tick`）が外部の embedding provider に送らない（Fake の歯。DB を要らない）。
 * 3実装の突き合わせは `packages/postgres/src/__tests__/embed-job-skips-withdrawn-memory.postgres.test.ts`。
 * 他の状態（active・archived）は今までどおり埋め込む（やりすぎの対照）。conformance suite には何も足していない（ADR 0434 決定5）。
 */

const ctx: Ctx = { tenantId: "fake-embed-skip" };
const SECRET = "secret-body-XYZ";
const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

async function run(state: "active" | "archived" | "forgotten" | "purged") {
  const stores = createFakeRuntimeStores();
  const calls: string[][] = [];
  const space = stores.embeddingProvider.space;
  const rt = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: {
      space,
      embed: async (_c, texts) => {
        calls.push([...texts]);
        return texts.map(() =>
          Array.from({ length: space.dimensions }, (_, i) => (i === 0 ? 1 : 0)),
        );
      },
    },
    hashContent: (c: string) => `sha(${c})`,
    clock: { now: () => new Date(Date.now() + 60_000) },
  });
  const created = await stores.memoryStore.createMemoryWithOutbox(
    ctx,
    {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: SECRET,
      contentHash: "h",
      digest: "d",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "m" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date(),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 8760,
      decayFloorAt: new Date(Date.now() + 1e12),
      embeddingStatus: "pending",
    },
    ["embed"],
  );
  const id = created.memory.id;
  if (state === "forgotten" || state === "purged") await rt.forget(ctx, { memoryId: id });
  if (state === "purged") await rt.purge(ctx, { memoryId: id });
  if (state === "archived") await stores.memoryStore.updateStatus(ctx, id, "archived");
  const t1 = await rt.tick(ctx, { leaseMs: 1000, kinds: ["embed"] });
  const t2 = await rt.tick(ctx, { leaseMs: 1000, kinds: ["embed"] });
  const vectors = await stores.vectorStore.getVectors!(ctx, space, [id]);
  return {
    inputs: calls.flat(),
    first: [t1.processed, t1.failed],
    second: [t2.processed, t2.failed],
    vectors: vectors.length,
  };
}

describe("Fake: 埋め込みジョブは、forget・purge した記憶の本文を provider に送らない（ADR 0541）", () => {
  for (const state of ["forgotten", "purged"] as const) {
    it(`${state}: provider を呼ばずにジョブを終え（complete）、2回目の tick で拾い直されず、ベクトルも書かない`, async () => {
      const r = await run(state);
      expect(r.inputs).toEqual([]);
      expect(r.first).toEqual([1, 0]);
      expect(r.second).toEqual([0, 0]);
      expect(r.vectors).toBe(0);
    });
  }
  for (const state of ["active", "archived"] as const) {
    it(`${state}: 今までどおり埋め込む（やりすぎの対照）`, async () => {
      const r = await run(state);
      expect(r.inputs).toEqual([SECRET]);
      expect(r.vectors).toBe(1);
    });
  }
});
