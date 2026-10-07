import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime, type ConsolidateOptions, type Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 大文字の uuid の id は含めない: 実装ごとの差が出るのはそこだけで、fixture の id は `mem-N` のため。同じ `EXPECTED` を実 Postgres と InMemory の側も縛る。
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ev: EventStore;
  /** 記憶を作り、ベクトルも入れる（`embeddingStatus: "ready"`）。 */
  mk: (ctx: Ctx, content: string) => Promise<Memory>;
  /** `utterance` の observation を作る。 */
  obs: (ctx: Ctx, externalId: string) => Promise<{ id: string }>;
  /** 決め打ちの LLM の応答（抽出の `memories` を差し替える）。 */
  setExtracted: (content: string) => void;
  base: string;
}

type Result = Record<string, unknown>;

async function scenario(env: Env): Promise<Result> {
  const { runtime, mem, ev, mk, obs, setExtracted } = env;
  const out: Result = {};
  let n = 0;
  const fresh = (): Ctx => ({ tenantId: `${env.base}-${(n += 1)}` });
  const event0 = (ctx: Ctx, id: string, kind: NewMemoryEvent["kind"]): NewMemoryEvent => ({
    tenantId: ctx.tenantId,
    memoryId: id,
    kind,
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  });
  const toState = async (ctx: Ctx, m: Memory, st: string) => {
    if (st === "superseded") {
      const winner = await mk(ctx, "winner of supersede");
      await mem.updateStatus(ctx, m.id, "superseded", { supersededById: winner.id });
    }
    if (st === "forgotten" || st === "purged") await mem.updateStatus(ctx, m.id, "forgotten");
    if (st === "archived") await mem.updateStatus(ctx, m.id, "archived");
    if (st === "purged") {
      await mem.purgeMemory!(
        ctx,
        m.id,
        { content: "[purged]", digest: "[purged]" },
        event0(ctx, m.id, "purged"),
      );
    }
  };
  const snap = async (ctx: Ctx, ms: Memory[]) => ({
    status: await Promise.all(ms.map(async (m) => (await mem.get(ctx, m.id))?.status)),
    events: (await ev.list(ctx, {})).map((e) => e.kind).sort(),
  });
  const STATES = ["active", "forgotten", "archived", "superseded", "purged"];
  for (const st of STATES) {
    for (const op of ["consolidate", "reflect"] as const) {
      const run = (ctx: Ctx, target: ConsolidateOptions["target"]) =>
        op === "consolidate"
          ? runtime.consolidate(ctx, { target })
          : runtime.reflect(ctx, { target });
      const shape = (r: Awaited<ReturnType<typeof run>>) => [
        r.outcome,
        "basis" in r ? r.basis.map((b) => b.kind) : null,
      ];
      let ctx = fresh();
      let a = await mk(ctx, "banana a");
      const a2 = await mk(ctx, "banana a2");
      let m = await mk(ctx, "banana m");
      await toState(ctx, m, st);
      out[`${op}(memoryIds [a, a2, m(${st})])`] = [
        shape(await run(ctx, { memoryIds: [a.id, a2.id, m.id] })),
        await snap(ctx, [a, a2, m]),
      ];
      ctx = fresh();
      a = await mk(ctx, "banana seed");
      m = await mk(ctx, "banana neighbor");
      await toState(ctx, m, st);
      out[`${op}(seed active, neighbor ${st})`] = [
        shape(await run(ctx, { seedMemoryId: a.id })),
        await snap(ctx, [a, m]),
      ];
      ctx = fresh();
      a = await mk(ctx, "banana seed");
      m = await mk(ctx, "banana neighbor");
      await toState(ctx, a, st);
      out[`${op}(seed ${st}, neighbor active)`] = [
        shape(await run(ctx, { seedMemoryId: a.id })),
        await snap(ctx, [a, m]),
      ];
      ctx = fresh();
      a = await mk(ctx, "banana a");
      m = await mk(ctx, "banana m");
      await toState(ctx, m, st);
      out[`${op}(query, one ${st})`] = [
        shape(await run(ctx, { query: { text: "banana", vector: [1, 0, 0], limit: 10 } })),
        await snap(ctx, [a, m]),
      ];
    }
    const ctx = fresh();
    const o = await obs(ctx, "ext-1");
    setExtracted("extracted fact");
    const first = await runtime.reextract(ctx, o.id);
    const prior = (await mem.get(ctx, first.memoryIds[0]!))!;
    await toState(ctx, prior, st);
    setExtracted("different fact");
    const second = await runtime.reextract(ctx, o.id);
    setExtracted("extracted fact");
    out[`reextract(prior memory ${st})`] = [
      first.memoryIds.length,
      second.memoryIds.length,
      second.supersededMemoryIds.length,
      second.skipped.map((s) => s.kind),
      await snap(ctx, [prior]),
    ];
  }
  let ctx = fresh();
  const gone = await obs(ctx, "ext-gone");
  await mem.eraseTenant!(ctx, { limit: 1000 });
  out["reextract(after eraseTenant)"] = await runtime.reextract(ctx, gone.id).then(
    () => "resolved",
    (e: unknown) => /observation not found/.test(String(e)),
  );
  out["reextract(unknown observation)"] = await runtime
    .reextract(fresh(), "00000000-0000-4000-8000-000000000000")
    .then(
      () => "resolved",
      (e: unknown) => /observation not found/.test(String(e)),
    );
  ctx = fresh();
  const o2 = await obs(ctx, "ext-x");
  const x1 = await runtime.reextract(ctx, o2.id);
  await runtime.forget(ctx, { memoryId: x1.memoryIds[0]! });
  await runtime.purge(ctx, { memoryId: x1.memoryIds[0]! });
  const again = await runtime.observe(ctx, {
    kind: "utterance",
    text: "I like bananas",
    externalId: "ext-x",
  });
  out["observe same externalId after forget+purge"] = [
    again.observationId === o2.id,
    again.extraction,
    (await mem.get(ctx, x1.memoryIds[0]!))?.content,
  ];
  ctx = fresh();
  const um = await mk(ctx, "banana usage");
  const rc = await runtime.recall(ctx, { text: "banana", vector: [1, 0, 0], limit: 10 });
  await toState(ctx, um, "purged");
  const mu = await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: rc.recallId,
    usedMemoryIds: [um.id],
  });
  out["observe memory_usage(purged memory)"] = [
    mu.memoryIds.length,
    (await mem.get(ctx, um.id))?.status,
  ];
  return out;
}

let extractedContent = "extracted fact";
const llm = {
  name: "canned",
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({
      outcome: "reflected",
      content: "CANNED merged",
      digest: "canned digest",
      tags: [],
      memories: [
        {
          content: extractedContent,
          digest: extractedContent,
          provenanceKind: "stated",
          confidence: 1,
        },
      ],
    }) as T,
};

const EXPECTED: Result = {
  "consolidate(memoryIds [a, a2, m(active)])": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded", "superseded"],
      events: ["created", "superseded", "superseded", "superseded"],
    },
  ],
  "consolidate(seed active, neighbor active)": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "consolidate(query, one active)": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "reflect(memoryIds [a, a2, m(active)])": [
    ["reflected", ["used", "used", "used"]],
    {
      status: ["active", "active", "active"],
      events: ["created"],
    },
  ],
  "reflect(seed active, neighbor active)": [
    ["reflected", ["used", "used"]],
    {
      status: ["active", "active"],
      events: ["created"],
    },
  ],
  "reflect(query, one active)": [
    ["reflected", ["used", "used"]],
    {
      status: ["active", "active"],
      events: ["created"],
    },
  ],
  "reextract(prior memory active)": [
    1,
    1,
    1,
    [],
    {
      status: ["superseded"],
      events: ["created", "created", "superseded"],
    },
  ],
  "consolidate(memoryIds [a, a2, m(forgotten)])": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded", "forgotten"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "consolidate(seed active, neighbor forgotten)": [
    ["nothing_to_consolidate", null],
    {
      status: ["active", "forgotten"],
      events: [],
    },
  ],
  "consolidate(seed forgotten, neighbor active)": [
    ["nothing_to_consolidate", null],
    {
      status: ["forgotten", "active"],
      events: [],
    },
  ],
  "consolidate(query, one forgotten)": [
    ["nothing_to_consolidate", null],
    {
      status: ["active", "forgotten"],
      events: [],
    },
  ],
  "reflect(memoryIds [a, a2, m(forgotten)])": [
    ["reflected", ["used", "used", "status_not_active"]],
    {
      status: ["active", "active", "forgotten"],
      events: ["created"],
    },
  ],
  "reflect(seed active, neighbor forgotten)": [
    ["reflected", ["used"]],
    {
      status: ["active", "forgotten"],
      events: ["created"],
    },
  ],
  "reflect(seed forgotten, neighbor active)": [
    ["nothing_to_reflect", ["status_not_active"]],
    {
      status: ["forgotten", "active"],
      events: [],
    },
  ],
  "reflect(query, one forgotten)": [
    ["reflected", ["used"]],
    {
      status: ["active", "forgotten"],
      events: ["created"],
    },
  ],
  "reextract(prior memory forgotten)": [
    1,
    0,
    0,
    ["status_not_active"],
    {
      status: ["forgotten"],
      events: ["created"],
    },
  ],
  "consolidate(memoryIds [a, a2, m(archived)])": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded", "archived"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "consolidate(seed active, neighbor archived)": [
    ["nothing_to_consolidate", null],
    {
      status: ["active", "archived"],
      events: [],
    },
  ],
  "consolidate(seed archived, neighbor active)": [
    ["nothing_to_consolidate", null],
    {
      status: ["archived", "active"],
      events: [],
    },
  ],
  "consolidate(query, one archived)": [
    ["nothing_to_consolidate", null],
    {
      status: ["active", "archived"],
      events: [],
    },
  ],
  "reflect(memoryIds [a, a2, m(archived)])": [
    ["reflected", ["used", "used", "status_not_active"]],
    {
      status: ["active", "active", "archived"],
      events: ["created"],
    },
  ],
  "reflect(seed active, neighbor archived)": [
    ["reflected", ["used"]],
    {
      status: ["active", "archived"],
      events: ["created"],
    },
  ],
  "reflect(seed archived, neighbor active)": [
    ["reflected", ["status_not_active", "used"]],
    {
      status: ["archived", "active"],
      events: ["created"],
    },
  ],
  "reflect(query, one archived)": [
    ["reflected", ["used"]],
    {
      status: ["active", "archived"],
      events: ["created"],
    },
  ],
  "reextract(prior memory archived)": [
    1,
    1,
    0,
    ["status_not_active"],
    {
      status: ["archived"],
      events: ["created", "created"],
    },
  ],
  "consolidate(memoryIds [a, a2, m(superseded)])": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded", "superseded"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "consolidate(seed active, neighbor superseded)": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "consolidate(seed superseded, neighbor active)": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "consolidate(query, one superseded)": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded"],
      events: ["created", "superseded", "superseded"],
    },
  ],
  "reflect(memoryIds [a, a2, m(superseded)])": [
    ["reflected", ["used", "used", "status_not_active"]],
    {
      status: ["active", "active", "superseded"],
      events: ["created"],
    },
  ],
  "reflect(seed active, neighbor superseded)": [
    ["reflected", ["used", "used"]],
    {
      status: ["active", "superseded"],
      events: ["created"],
    },
  ],
  "reflect(seed superseded, neighbor active)": [
    ["reflected", ["status_not_active", "used", "used"]],
    {
      status: ["superseded", "active"],
      events: ["created"],
    },
  ],
  "reflect(query, one superseded)": [
    ["reflected", ["used", "used"]],
    {
      status: ["active", "superseded"],
      events: ["created"],
    },
  ],
  "reextract(prior memory superseded)": [
    1,
    1,
    0,
    ["status_not_active"],
    {
      status: ["superseded"],
      events: ["created", "created"],
    },
  ],
  "consolidate(memoryIds [a, a2, m(purged)])": [
    ["consolidated", null],
    {
      status: ["superseded", "superseded", "forgotten"],
      events: ["created", "purged", "superseded", "superseded"],
    },
  ],
  "consolidate(seed active, neighbor purged)": [
    ["nothing_to_consolidate", null],
    {
      status: ["active", "forgotten"],
      events: ["purged"],
    },
  ],
  "consolidate(seed purged, neighbor active)": [
    ["nothing_to_consolidate", null],
    {
      status: ["forgotten", "active"],
      events: ["purged"],
    },
  ],
  "consolidate(query, one purged)": [
    ["nothing_to_consolidate", null],
    {
      status: ["active", "forgotten"],
      events: ["purged"],
    },
  ],
  "reflect(memoryIds [a, a2, m(purged)])": [
    ["reflected", ["used", "used", "status_not_active"]],
    {
      status: ["active", "active", "forgotten"],
      events: ["created", "purged"],
    },
  ],
  "reflect(seed active, neighbor purged)": [
    ["reflected", ["used"]],
    {
      status: ["active", "forgotten"],
      events: ["created", "purged"],
    },
  ],
  "reflect(seed purged, neighbor active)": [
    ["nothing_to_reflect", ["status_not_active"]],
    {
      status: ["forgotten", "active"],
      events: ["purged"],
    },
  ],
  "reflect(query, one purged)": [
    ["reflected", ["used"]],
    {
      status: ["active", "forgotten"],
      events: ["created", "purged"],
    },
  ],
  "reextract(prior memory purged)": [
    1,
    0,
    0,
    ["status_not_active"],
    {
      status: ["forgotten"],
      events: ["created", "purged"],
    },
  ],
  "reextract(after eraseTenant)": true,
  "reextract(unknown observation)": true,
  "observe same externalId after forget+purge": [true, "skipped", "[purged]"],
  "observe memory_usage(purged memory)": [1, "forgotten"],
};

let hashCounter = 0;
function newMemory(ctx: Ctx, content: string): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `llm-paths-${hashCounter}`,
    digest: content,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
  };
}

describe("consolidate・reflect・reextract・observe の「消した後の参照」（Fake）", () => {
  it("消した後の記憶に対する consolidate・reflect・reextract・observe・recall の結果が、Postgres で実測した値（EXPECTED）と一致する", async () => {
    const stores = createFakeRuntimeStores();
    const space = { provider: "fake", model: "fake-model", dimensions: 3 };
    const runtime: Runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      lexicalStore: stores.lexicalStore,
      eventStore: stores.eventStore,
      relationStore: stores.relationStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm,
      embeddingProvider: { space, embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]) },
      hashContent: (content) => `h(${content})`,
      clock: { now: () => new Date("2026-01-02T00:00:00.000Z") },
    });
    const out = await scenario({
      runtime,
      mem: stores.memoryStore as MemoryStore,
      ev: stores.eventStore as EventStore,
      base: "llm-paths-fake",
      mk: async (ctx, content) => {
        const m = await stores.memoryStore.createMemory(ctx, newMemory(ctx, content));
        await stores.vectorStore.upsert(ctx, space, m.id, [1, 0, 0]);
        return m;
      },
      obs: (ctx, externalId) =>
        stores.memoryStore.createObservation(ctx, {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId,
          kind: "utterance",
          payload: { text: "I like bananas" },
          occurredAt: null,
        }),
      setExtracted: (content) => {
        extractedContent = content;
      },
    });
    expect(out).toEqual(EXPECTED);
  });
});
