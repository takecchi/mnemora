import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { TenantSettingsStore } from "../interfaces/tenant-settings-store.js";
import { createRuntime, type Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ts: TenantSettingsStore;
  fresh: () => Ctx;
  setExtracted: (content: string) => void;
}

type Result = Record<string, unknown>;

/** 活動時計（`decay_clock = "activity"`）の経路を Runtime の操作列で縛る。同じ `EXPECTED` を実 Postgres と InMemory の側も縛る。 */
async function scenario(env: Env): Promise<Result> {
  const { runtime, mem, ts, fresh, setExtracted } = env;
  const out: Result = {};
  const FAR = new Date("2040-01-01T00:00:00.000Z"); // 壁時計の軸では全員が沈んでいる時刻
  const seqOf = async (ctx: Ctx, ids: Record<string, string>) => {
    const r: Record<string, unknown> = {};
    for (const [k, id] of Object.entries(ids)) {
      const m = await mem.get(ctx, id);
      r[k] = m ? [m.status, m.decayBaseSeq, m.decayFloorSeq, m.halfLifeRecalls] : null;
    }
    return r;
  };
  const counters = async (ctx: Ctx, subjects: string[]) => ({
    T: await ts.getActivitySeq!(ctx),
    hasS: await ts.hasSubjectActivityCounters!(ctx),
    S: await ts.getSubjectActivitySeqs!(ctx, subjects),
  });
  const settle = async (ctx: Ctx) => {
    for (let i = 0; i < 6; i += 1) {
      if ((await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["embed"] })).processed === 0) break;
    }
  };
  const observeOne = async (ctx: Ctx, text: string): Promise<string> => {
    setExtracted(text);
    const r = await runtime.observe(ctx, { kind: "utterance", text });
    return r.memoryIds[0]!;
  };
  const aliasOf = (ids: Record<string, string>) => {
    const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
    return (id: string) => byId.get(id) ?? "?";
  };
  const recallAliases = async (
    ctx: Ctx,
    ids: Record<string, string>,
    counting?: "tenant" | "subject",
  ) => {
    const r = await runtime.recall(ctx, {
      text: "fact",
      limit: 20,
      association: null,
      ...(counting ? { activityCounting: counting } : {}),
    });
    const alias = aliasOf(ids);
    return {
      ids: r.memories.map((m) => alias(m.memoryId)).sort(),
      recallId: r.recallId,
      omitted: JSON.stringify(
        r.omitted.map((o) => {
          const x = o as unknown as Record<string, unknown>;
          return [
            x["kind"],
            x["reason"] ?? x["condition"] ?? null,
            x["scopeRelation"] ?? null,
            x["count"],
          ];
        }),
      ),
      totalInScope: r.index.totalInScope,
      band: (r.index.digestBand ?? []).map((d) => alias(d.memoryId)).sort(),
    };
  };

  const ctx = fresh();
  const ctxA: Ctx = { ...ctx, subjectId: "alice" };
  const ctxB: Ctx = { ...ctx, subjectId: "bob" };
  await ts.setDecayClock!(ctx, "activity");
  await ts.setDefaultHalfLifeRecalls!(ctx, 3);
  const ids: Record<string, string> = {};
  ids["m0"] = await observeOne(ctx, "fact zero");
  ids["mA"] = await observeOne(ctxA, "fact alice");
  ids["mB"] = await observeOne(ctxB, "fact bob");
  await settle(ctx);
  out["1 created in activity mode"] = [
    await seqOf(ctx, ids),
    await counters(ctx, ["alice", "bob"]),
  ];

  for (let i = 0; i < 2; i += 1) await recallAliases(ctx, ids);
  for (let i = 0; i < 2; i += 1) await recallAliases(ctxA, ids, "subject");
  await ts.setDefaultHalfLifeRecalls!(ctx, 1);
  ids["q0"] = await observeOne(ctx, "fact quick zero");
  ids["qA"] = await observeOne(ctxA, "fact quick alice");
  await settle(ctx);
  out["2 counters moved, then short-lived memories"] = [
    await seqOf(ctx, ids),
    await counters(ctx, ["alice", "bob"]),
  ];

  const steps: unknown[] = [];
  for (let i = 0; i < 18; i += 1) {
    const kind = i % 3;
    const c = kind === 1 ? ctxA : kind === 2 ? ctxB : ctx;
    const counting = kind === 0 ? undefined : "subject";
    const r = await recallAliases(c, ids, counting);
    steps.push([
      kind === 0 ? "tenant" : kind === 1 ? "alice(subject)" : "bob(subject)",
      r.ids,
      r.omitted,
      r.totalInScope,
      r.band,
      await counters(ctx, ["alice", "bob"]),
    ]);
  }
  out["3 recalls advance the clock; the gate drops memories that sank"] = steps;
  out["3b memories after the recalls"] = await seqOf(ctx, ids);

  const last = await recallAliases(ctx, ids);
  setExtracted("unused");
  await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: last.recallId,
    usedMemoryIds: [ids["m0"]!, ids["mA"]!],
  });
  out["4 usage reinforce (subjectless and alice)"] = [
    await seqOf(ctx, ids),
    await counters(ctx, ["alice", "bob"]),
  ];

  const c1 = await observeOne(ctxA, "fact alice consolidation source one");
  const c2 = await observeOne(ctxA, "fact alice consolidation source two");
  await settle(ctx);
  const merged = await runtime.consolidate(ctxA, { target: { memoryIds: [c1, c2] } });
  const reflected = await runtime.reflect(ctxA, { target: { memoryIds: [ids["mA"]!] } });
  const mergedId = merged.consolidatedMemoryId;
  const reflectedId = reflected.reflectedMemoryId;
  const written: Record<string, string> = {};
  if (mergedId) written["consolidated"] = mergedId;
  if (reflectedId) written["reflected"] = reflectedId;
  out["5 consolidate and reflect write the triple"] = [
    merged.outcome,
    reflected.outcome,
    await seqOf(ctx, written),
    await counters(ctx, ["alice", "bob"]),
  ];

  // 6. sweepArchive: 同じ状態のテナントを3つ作り直すのは重いので、同じテナントで順に（掃引は沈んだ active だけを選ぶ）
  const sweep = async (
    label: string,
    opts: { clock?: "wall" | "activity" | "either"; now?: Date },
  ) => {
    const r = await runtime.sweepArchive(ctx, {
      now: opts.now ?? new Date(),
      limit: 100,
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    const alias = aliasOf({ ...ids, ...written });
    out[`6 sweepArchive ${label}`] = [
      r.archived.map((x) => alias(x.memoryId)).sort(),
      r.reachedLimit,
      await seqOf(ctx, { ...ids, ...written }),
    ];
  };
  const tenantRecalls = async (n: number) => {
    for (let i = 0; i < n; i += 1) await recallAliases(ctx, ids);
  };
  await sweep("clock activity, now=today: only qA has sunk", { clock: "activity" });
  await sweep("clock either, now=today: wall axis alive, nothing", { clock: "either" });
  await tenantRecalls(2); // T=8: q0 も沈む
  await sweep("clock wall, now=today: wall axis alive, nothing", { clock: "wall" });
  await sweep("clock either, now=FAR: both axes sunk, q0 only", { clock: "either", now: FAR });
  await tenantRecalls(12); // T=20: m0（床19）・mB・mA・consolidated・reflected も沈む
  out["6b recall after the clock has run far (the gate drops what sank)"] = (
    await recallAliases(ctx, ids)
  ).ids;
  await sweep("clock wall, now=today: still nothing although the activity axis sank", {
    clock: "wall",
  });
  await sweep("tenant default (activity), now=today: everything that sank", {});
  out["6c recall after the sweeps"] = (await recallAliases(ctx, ids)).ids;

  const ctx2 = fresh();
  const ids2: Record<string, string> = {};
  ids2["wall0"] = await observeOne(ctx2, "fact written under the wall clock");
  await settle(ctx2);
  await ts.setDecayClock!(ctx2, "activity");
  await ts.setDefaultHalfLifeRecalls!(ctx2, 1);
  ids2["act0"] = await observeOne(ctx2, "fact written under the activity clock");
  await settle(ctx2);
  const switchSteps: unknown[] = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await recallAliases(ctx2, ids2);
    switchSteps.push([r.ids, (await counters(ctx2, [])).T]);
  }
  out["7 switch wall to activity: recalls"] = switchSteps;
  const sw = await runtime.sweepArchive(ctx2, { now: new Date(), limit: 100 });
  const alias2 = aliasOf(ids2);
  out["7b switch: sweep (the wall-era memory has no floor and stays)"] = [
    sw.archived.map((x) => alias2(x.memoryId)).sort(),
    await seqOf(ctx2, ids2),
  ];

  const ctx3 = fresh();
  const ctx3A: Ctx = { ...ctx3, subjectId: "alice" };
  await ts.setDecayClock!(ctx3, "activity");
  await ts.setDefaultHalfLifeRecalls!(ctx3, 1);
  for (let i = 0; i < 2; i += 1)
    await runtime.recall(ctx3A, {
      text: "fact",
      limit: 5,
      association: null,
      activityCounting: "subject",
    });
  const ids3: Record<string, string> = {};
  ids3["b0"] = await observeOne(ctx3, "fact boundary zero");
  ids3["bA"] = await observeOne(ctx3A, "fact boundary alice");
  await settle(ctx3);
  const boundary: unknown[] = [await seqOf(ctx3, ids3), await counters(ctx3, ["alice"])];
  const alias3 = aliasOf(ids3);
  for (let i = 0; i < 6; i += 1) {
    const r = await recallAliases(ctx3, ids3);
    const sw = await runtime.sweepArchive(ctx3, { now: new Date(), limit: 10, clock: "activity" });
    boundary.push([
      r.ids,
      r.omitted,
      r.totalInScope,
      sw.archived.map((x) => alias3(x.memoryId)).sort(),
      (await counters(ctx3, ["alice"])).T,
    ]);
  }
  out[
    "8 boundary: sunk exactly when floor <= now (sweep) and gone from the gate when floor <= now"
  ] = boundary;
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
  "1 created in activity mode": [
    {
      m0: ["active", 0, 13, 3],
      mA: ["active", 0, 13, 3],
      mB: ["active", 0, 13, 3],
    },
    {
      T: 0,
      hasS: false,
      S: {},
    },
  ],
  "2 counters moved, then short-lived memories": [
    {
      m0: ["active", 0, 13, 3],
      mA: ["active", 0, 13, 3],
      mB: ["active", 0, 13, 3],
      q0: ["active", 2, 7, 1],
      qA: ["active", 4, 9, 1],
    },
    {
      T: 2,
      hasS: true,
      S: {
        alice: 2,
      },
    },
  ],
  "3 recalls advance the clock; the gate drops memories that sank": [
    [
      "tenant",
      ["m0", "mA", "mB", "q0", "qA"],
      "[]",
      5,
      [],
      {
        T: 3,
        hasS: true,
        S: {
          alice: 2,
        },
      },
    ],
    [
      "alice(subject)",
      ["mA", "qA"],
      "[]",
      2,
      [],
      {
        T: 3,
        hasS: true,
        S: {
          alice: 3,
        },
      },
    ],
    [
      "bob(subject)",
      ["mB"],
      "[]",
      1,
      [],
      {
        T: 3,
        hasS: true,
        S: {
          alice: 3,
          bob: 1,
        },
      },
    ],
    [
      "tenant",
      ["m0", "mA", "mB", "q0", "qA"],
      "[]",
      5,
      [],
      {
        T: 4,
        hasS: true,
        S: {
          alice: 3,
          bob: 1,
        },
      },
    ],
    [
      "alice(subject)",
      ["mA", "qA"],
      "[]",
      2,
      [],
      {
        T: 4,
        hasS: true,
        S: {
          alice: 4,
          bob: 1,
        },
      },
    ],
    [
      "bob(subject)",
      ["mB"],
      "[]",
      1,
      [],
      {
        T: 4,
        hasS: true,
        S: {
          alice: 4,
          bob: 2,
        },
      },
    ],
    [
      "tenant",
      ["m0", "mA", "mB", "q0"],
      '[["below_threshold",null,null,1]]',
      5,
      ["qA"],
      {
        T: 5,
        hasS: true,
        S: {
          alice: 4,
          bob: 2,
        },
      },
    ],
    [
      "alice(subject)",
      ["mA"],
      '[["filtered","decayed","within_scope",1],["ann_unreached",null,null,null]]',
      2,
      ["qA"],
      {
        T: 5,
        hasS: true,
        S: {
          alice: 5,
          bob: 2,
        },
      },
    ],
    [
      "bob(subject)",
      ["mB"],
      "[]",
      1,
      [],
      {
        T: 5,
        hasS: true,
        S: {
          alice: 5,
          bob: 3,
        },
      },
    ],
    [
      "tenant",
      ["m0", "mB", "q0"],
      '[["below_threshold",null,null,1],["filtered","decayed","within_scope",1],["ann_unreached",null,null,null]]',
      5,
      ["mA", "qA"],
      {
        T: 6,
        hasS: true,
        S: {
          alice: 5,
          bob: 3,
        },
      },
    ],
    [
      "alice(subject)",
      [],
      '[["below_threshold",null,null,1],["filtered","decayed","within_scope",1],["ann_unreached",null,null,null]]',
      2,
      ["mA", "qA"],
      {
        T: 6,
        hasS: true,
        S: {
          alice: 6,
          bob: 3,
        },
      },
    ],
    [
      "bob(subject)",
      ["mB"],
      "[]",
      1,
      [],
      {
        T: 6,
        hasS: true,
        S: {
          alice: 6,
          bob: 4,
        },
      },
    ],
    [
      "tenant",
      ["m0"],
      '[["below_threshold",null,null,3],["filtered","decayed","within_scope",1],["ann_unreached",null,null,null]]',
      5,
      ["mA", "mB", "q0", "qA"],
      {
        T: 7,
        hasS: true,
        S: {
          alice: 6,
          bob: 4,
        },
      },
    ],
    [
      "alice(subject)",
      [],
      '[["filtered","decayed","within_scope",2],["ann_unreached",null,null,null]]',
      2,
      ["mA", "qA"],
      {
        T: 7,
        hasS: true,
        S: {
          alice: 7,
          bob: 4,
        },
      },
    ],
    [
      "bob(subject)",
      [],
      '[["below_threshold",null,null,1]]',
      1,
      ["mB"],
      {
        T: 7,
        hasS: true,
        S: {
          alice: 7,
          bob: 5,
        },
      },
    ],
    [
      "tenant",
      ["m0"],
      '[["below_threshold",null,null,1],["filtered","decayed","within_scope",3],["ann_unreached",null,null,null]]',
      5,
      ["mA", "mB", "q0", "qA"],
      {
        T: 8,
        hasS: true,
        S: {
          alice: 7,
          bob: 5,
        },
      },
    ],
    [
      "alice(subject)",
      [],
      '[["filtered","decayed","within_scope",2],["ann_unreached",null,null,null]]',
      2,
      ["mA", "qA"],
      {
        T: 8,
        hasS: true,
        S: {
          alice: 8,
          bob: 5,
        },
      },
    ],
    [
      "bob(subject)",
      [],
      '[["filtered","decayed","within_scope",1],["ann_unreached",null,null,null]]',
      1,
      ["mB"],
      {
        T: 8,
        hasS: true,
        S: {
          alice: 8,
          bob: 6,
        },
      },
    ],
  ],
  "3b memories after the recalls": {
    m0: ["active", 0, 13, 3],
    mA: ["active", 0, 13, 3],
    mB: ["active", 0, 13, 3],
    q0: ["active", 2, 7, 1],
    qA: ["active", 4, 9, 1],
  },
  "4 usage reinforce (subjectless and alice)": [
    {
      m0: ["active", 9, 22, 3],
      mA: ["active", 17, 30, 3],
      mB: ["active", 0, 13, 3],
      q0: ["active", 2, 7, 1],
      qA: ["active", 4, 9, 1],
    },
    {
      T: 9,
      hasS: true,
      S: {
        alice: 8,
        bob: 6,
      },
    },
  ],
  "5 consolidate and reflect write the triple": [
    "consolidated",
    "reflected",
    {
      consolidated: ["active", 17, 22, 1],
      reflected: ["active", 17, 22, 1],
    },
    {
      T: 9,
      hasS: true,
      S: {
        alice: 8,
        bob: 6,
      },
    },
  ],
  "6 sweepArchive clock activity, now=today: only qA has sunk": [
    ["mB", "q0", "qA"],
    false,
    {
      m0: ["active", 9, 22, 3],
      mA: ["active", 17, 30, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 17, 22, 1],
      reflected: ["active", 17, 22, 1],
    },
  ],
  "6 sweepArchive clock either, now=today: wall axis alive, nothing": [
    [],
    false,
    {
      m0: ["active", 9, 22, 3],
      mA: ["active", 17, 30, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 17, 22, 1],
      reflected: ["active", 17, 22, 1],
    },
  ],
  "6 sweepArchive clock wall, now=today: wall axis alive, nothing": [
    [],
    false,
    {
      m0: ["active", 9, 22, 3],
      mA: ["active", 17, 30, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 17, 22, 1],
      reflected: ["active", 17, 22, 1],
    },
  ],
  "6 sweepArchive clock either, now=FAR: both axes sunk, q0 only": [
    [],
    false,
    {
      m0: ["active", 9, 22, 3],
      mA: ["active", 17, 30, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 17, 22, 1],
      reflected: ["active", 17, 22, 1],
    },
  ],
  "6b recall after the clock has run far (the gate drops what sank)": [],
  "6 sweepArchive clock wall, now=today: still nothing although the activity axis sank": [
    [],
    false,
    {
      m0: ["active", 9, 22, 3],
      mA: ["active", 17, 30, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 17, 22, 1],
      reflected: ["active", 17, 22, 1],
    },
  ],
  "6 sweepArchive tenant default (activity), now=today: everything that sank": [
    ["consolidated", "m0", "mA", "reflected"],
    false,
    {
      m0: ["archived", 9, 22, 3],
      mA: ["archived", 17, 30, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["archived", 17, 22, 1],
      reflected: ["archived", 17, 22, 1],
    },
  ],
  "6c recall after the sweeps": [],
  "7 switch wall to activity: recalls": [
    [["act0", "wall0"], 1],
    [["act0", "wall0"], 2],
    [["act0", "wall0"], 3],
    [["act0", "wall0"], 4],
    [["wall0"], 5],
    [["wall0"], 6],
    [["wall0"], 7],
    [["wall0"], 8],
  ],
  "7b switch: sweep (the wall-era memory has no floor and stays)": [
    ["act0"],
    {
      wall0: ["active", null, null, null],
      act0: ["archived", 0, 5, 1],
    },
  ],
  "8 boundary: sunk exactly when floor <= now (sweep) and gone from the gate when floor <= now": [
    {
      b0: ["active", 0, 5, 1],
      bA: ["active", 2, 7, 1],
    },
    {
      T: 0,
      hasS: true,
      S: {
        alice: 2,
      },
    },
    [["b0", "bA"], "[]", 2, [], 1],
    [["b0", "bA"], "[]", 2, [], 2],
    [["b0", "bA"], "[]", 2, [], 3],
    [["b0", "bA"], "[]", 2, [], 4],
    [[], '[["below_threshold",null,null,2]]', 2, ["b0", "bA"], 5],
    [[], '[["filtered","archived","outside_scope",2]]', 0, [], 6],
  ],
};

describe("活動時計（decay_clock = activity）の経路（Fake）", () => {
  it("decay_clock = activity での observe・recall・consolidate・reflect・sweepArchive・tick の結果（活動カウンタを含む）が、Postgres で実測した値（EXPECTED）と一致する", async () => {
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
    });
    let n = 0;
    const out = await scenario({
      runtime,
      mem: stores.memoryStore as MemoryStore,
      ts: stores.tenantSettingsStore as TenantSettingsStore,
      fresh: () => ({ tenantId: `activity-clock-fake-${(n += 1)}` }),
      setExtracted: (content) => {
        extractedContent = content;
      },
    });
    expect(out).toEqual(EXPECTED);
  });
});
