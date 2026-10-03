import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { Memory } from "../memory.js";
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

// "purgedOnly": status は active のまま `purgedAt` だけが立った行（runtime の経路では作れない——purge は forgotten からしか通らない。
// 判定の `purgedAt` 側だけを独立に縛るため、`get` が返す行を差し替えて作る）。
function withPurgedAtOnly<T extends { get: (c: Ctx, id: string) => Promise<Memory | null> }>(
  store: T,
): T {
  return new Proxy(store, {
    get(target, prop, recv) {
      if (prop === "get") {
        return async (c: Ctx, id: string) => {
          const m = await target.get(c, id);
          return m ? ({ ...m, status: "active", purgedAt: new Date() } as Memory) : m;
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function run(
  state: "active" | "archived" | "forgotten" | "purged" | "purgedOnly",
  opts: { withSignal?: boolean; expireLeaseBetweenTicks?: boolean } = {},
) {
  const stores = createFakeRuntimeStores();
  // 時計は、1回目の tick の後に 1 時間進められる（リースが切れた状態を作る。`complete` されていないジョブは取り直される）。
  let clockOffsetMs = 60_000;
  const calls: string[][] = [];
  const hookCalls: string[] = [];
  const space = stores.embeddingProvider.space;
  const rt = createRuntime({
    memoryStore: state === "purgedOnly" ? withPurgedAtOnly(stores.memoryStore) : stores.memoryStore,
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
    embeddingInput: (m) => {
      hookCalls.push(m.id);
      return m.content;
    },
    hashContent: (c: string) => `sha(${c})`,
    clock: { now: () => new Date(Date.now() + clockOffsetMs) },
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
  // `signal` を渡す経路（`tick` の `opts.signal`）でも、同じく provider を呼ばない。
  const tickOpts = {
    leaseMs: 1000,
    kinds: ["embed" as const],
    ...(opts.withSignal ? { signal: new AbortController().signal } : {}),
  };
  const t1 = await rt.tick(ctx, tickOpts);
  if (opts.expireLeaseBetweenTicks) clockOffsetMs += 3_600_000;
  const t2 = await rt.tick(ctx, tickOpts);
  const vectors = await stores.vectorStore.getVectors!(ctx, space, [id]);
  const after = await stores.memoryStore.get(ctx, id);
  return {
    hookCalls: hookCalls.length,
    embeddingStatus: after?.embeddingStatus,
    inputs: calls.flat(),
    first: [t1.processed, t1.failed],
    second: [t2.processed, t2.failed],
    vectors: vectors.length,
  };
}

describe("Fake: 埋め込みジョブは、forget・purge した記憶の本文を provider に送らない（ADR 0541）", () => {
  for (const state of ["forgotten", "purged", "purgedOnly"] as const) {
    it(`${state}: provider を呼ばずにジョブを終え（complete）、2回目の tick で拾い直されず、ベクトルも書かない`, async () => {
      const r = await run(state);
      expect(r.inputs).toEqual([]);
      expect(r.first).toEqual([1, 0]);
      expect(r.second).toEqual([0, 0]);
      expect(r.vectors).toBe(0);
      expect(r.hookCalls).toBe(0); // embeddingInput のフックも呼ばない
      expect(r.embeddingStatus).toBe("pending"); // embeddingStatus は触らない
    });
  }
  for (const state of ["active", "archived"] as const) {
    it(`${state}: 今までどおり埋め込む（やりすぎの対照）`, async () => {
      const r = await run(state);
      expect(r.inputs).toEqual([SECRET]);
      expect(r.vectors).toBe(1);
      expect(r.hookCalls).toBe(1);
      expect(r.embeddingStatus).toBe("ready");
    });
  }

  // `tick` に `signal` を渡す経路でも守る（判定を signal の有無で変えない）。
  for (const state of ["forgotten", "purged", "purgedOnly"] as const) {
    it(`${state}: tick に signal を渡しても、provider もフックも呼ばない`, async () => {
      const r = await run(state, { withSignal: true });
      expect(r.inputs).toEqual([]);
      expect(r.hookCalls).toBe(0);
      expect(r.first).toEqual([1, 0]);
      expect(r.vectors).toBe(0);
      expect(r.embeddingStatus).toBe("pending");
    });
  }
  it("active: tick に signal を渡しても、今までどおり埋め込む（対照）", async () => {
    const r = await run("active", { withSignal: true });
    expect(r.inputs).toEqual([SECRET]);
    expect(r.embeddingStatus).toBe("ready");
  });

  // 時計を進めてリースを切らせても、`complete` 済みのジョブは取り直されない（`complete` せずリースを残しただけなら、ここで取り直される）。
  for (const state of ["forgotten", "purged", "active"] as const) {
    it(`${state}: リースが切れる時刻まで時計を進めても、2回目の tick で拾い直されない（complete 済み）`, async () => {
      const r = await run(state, { expireLeaseBetweenTicks: true });
      expect(r.first).toEqual([1, 0]);
      expect(r.second).toEqual([0, 0]);
      expect(r.inputs).toEqual(state === "active" ? [SECRET] : []);
    });
  }
});
