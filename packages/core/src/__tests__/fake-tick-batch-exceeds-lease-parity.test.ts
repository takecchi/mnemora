import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../ctx.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { OutboxStore } from "../interfaces/outbox-store.js";
import type { NewMemory } from "../memory.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createRuntime, type Runtime, type TickResult } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 同じ `EXPECTED` を実 Postgres と InMemory の側も縛る。 */
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ev: EventStore;
  ob: OutboxStore;
  rows: (ctx: Ctx) => Promise<Array<Record<string, unknown>>>;
  fresh: () => Ctx;
  /** `kind` のジョブを2本（と、consolidate・reflect には各ジョブの近傍の記憶2件ずつ）積む。extract は observation を2件作る。 */
  seedJobs: (ctx: Ctx, kind: Kind) => Promise<{ observationIds: string[]; seedIds: string[] }>;
  setClockOffset: (ms: number) => void;
  /** provider（LLM か embed）の呼び出しの前に走る門。引数は、その provider の（1 始まりの）呼び出し番号。 */
  setGate: (provider: "llm" | "embed", gate: ((n: number) => Promise<void>) | null) => void;
  /** LLM の応答の差し替え（抽出の `memories`）。`null` を返した呼び出しは既定の応答。 */
  setLlmOverride: (fn: ((n: number) => Array<{ content: string }> | null) | null) => void;
  /** これまでの provider の呼び出し回数を返して、0 に戻す。 */
  takeCalls: () => { llm: number; embed: number };
}

type Kind = "embed" | "extract" | "consolidate" | "reflect";
type Result = Record<string, unknown>;

/**
 * 順序は時計のオフセットと provider の前の門（Promise）で決める: A の2件目が門に着いたところで時計を進め、
 * (1) 別の `tick` B が2件目を再 claim して最後まで処理する／(2) 誰も取り直さない、のあと A の門を開ける。
 * リースはバッチの claim 時点から数えるので、1件あたりの処理が `leaseMs` より短くても切れる。
 */
async function scenario(env: Env): Promise<Result> {
  const {
    runtime,
    mem,
    ev,
    ob,
    rows,
    fresh,
    seedJobs,
    setClockOffset,
    setGate,
    setLlmOverride,
    takeCalls,
  } = env;
  const out: Result = {};
  const T = (t: TickResult) => [
    t.processed,
    t.failed,
    t.unsupported.length,
    t.leaseConflicts.map((x) => [x.kind, x.attemptedOutcome]),
  ];
  const summary = async (ctx: Ctx) => ({
    rows: (await rows(ctx))
      .map((r) => [r["kind"], r["attempts"], r["done"], r["failed"]])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    events: (await ev.list(ctx, {})).map((e) => e.kind).sort(),
  });
  const perObservation = async (ctx: Ctx, ids: string[]) => {
    const per: unknown[] = [];
    for (const id of ids) {
      const ms = await mem.listBySourceObservationAllVersions(ctx, id);
      per.push(ms.map((m) => [m.content, m.status]).sort());
    }
    return per;
  };
  const run = async (ctx: Ctx, kind: Kind, takeover: boolean) => {
    const gateProvider = kind === "embed" ? "embed" : "llm";
    setClockOffset(0);
    takeCalls();
    const seeded = await seedJobs(ctx, kind);
    let fired = false;
    let b: TickResult | null = null;
    setGate(gateProvider, async (n) => {
      if (n !== 2 || fired) return;
      fired = true;
      setClockOffset(1200); // バッチの claim (offset 0) から 1200ms: leaseMs 1000 を超えた
      if (takeover) b = await runtime.tick(ctx, { leaseMs: 1000, kinds: [kind], claimedBy: "B" });
    });
    let a: TickResult;
    try {
      a = await runtime.tick(ctx, { leaseMs: 1000, limit: 2, kinds: [kind], claimedBy: "A" });
    } finally {
      setGate(gateProvider, null);
      setClockOffset(0);
    }
    return {
      fired,
      A: T(a),
      B: b ? T(b) : null,
      calls: takeCalls(),
      ...(await summary(ctx)),
      ...seeded,
    };
  };
  const strip = (r: Awaited<ReturnType<typeof run>>) => {
    const { observationIds: _o, seedIds: _s, ...rest } = r;
    return rest;
  };
  for (const kind of ["embed", "extract", "consolidate", "reflect"] as Kind[]) {
    out[`${kind}: A's job 2 outlives the lease and B re-claims it`] = strip(
      await run(fresh(), kind, true),
    );
    out[`${kind}: A's job 2 outlives the lease and nobody re-claims it`] = strip(
      await run(fresh(), kind, false),
    );
  }
  const fact = (content: string) => [{ content }];
  for (const [label, override] of [
    ["same candidate", (n: number) => (n === 2 || n === 3 ? fact("shared fact") : null)],
    [
      "different candidates",
      (n: number) => (n === 2 ? fact("A fact") : n === 3 ? fact("B fact") : null),
    ],
  ] as Array<[string, (n: number) => Array<{ content: string }> | null]>) {
    const ctx = fresh();
    setLlmOverride(override);
    try {
      const r = await run(ctx, "extract", true);
      out[`extract doubled (${label}): memories per observation`] = [
        r.A,
        r.B,
        await perObservation(ctx, r.observationIds),
      ];
    } finally {
      setLlmOverride(null);
    }
  }
  {
    const ctx = fresh();
    setLlmOverride((n) => (n === 3 ? fact("B fact") : null));
    setClockOffset(0);
    takeCalls();
    const seeded = await seedJobs(ctx, "extract");
    let fired = false;
    let b: TickResult | null = null;
    setGate("llm", async (n) => {
      if (n !== 2 || fired) return;
      fired = true;
      setClockOffset(1200);
      b = await runtime.tick(ctx, { leaseMs: 1000, kinds: ["extract"], claimedBy: "B" });
      throw new Error("A's LLM died late");
    });
    try {
      const a = await runtime.tick(ctx, {
        leaseMs: 1000,
        limit: 2,
        kinds: ["extract"],
        claimedBy: "A",
      });
      out["extract doubled (A's LLM fails late after B completed): memories per observation"] = [
        T(a),
        b ? T(b) : null,
        await perObservation(ctx, seeded.observationIds),
      ];
    } finally {
      setGate("llm", null);
      setLlmOverride(null);
      setClockOffset(0);
    }
  }
  {
    const ctx = fresh();
    const r = await run(ctx, "reflect", true);
    const reflected: number[] = [];
    for (const e of await ev.list(ctx, { kind: "created" })) {
      const m = await mem.get(ctx, e.memoryId!);
      if (m && m.provenance.kind === "reflected") reflected.push(m.provenance.sources?.length ?? 0);
    }
    const seeds = await Promise.all(r.seedIds.map((id) => mem.get(ctx, id)));
    out["reflect doubled: reflected memories and the seeds' status"] = [
      reflected.sort(),
      seeds.map((m) => m?.status),
    ];
  }
  {
    // limit が行数より小さいときの取り分と、リースの切れ目（ちょうど `leaseMs`・1ms 前）での取り直し
    const ctx = fresh();
    await seedJobs(ctx, "embed");
    const at = Date.now() + 60_000;
    const claimAt = async (offset: number, limit: number) =>
      (
        await ob.claimBatch(ctx, {
          limit,
          now: new Date(at + offset),
          claimedBy: "w",
          leaseMs: 1000,
          kinds: ["embed"],
        })
      )
        .map((j) => j.attempts)
        .sort();
    out["claim: limit below the row count, then the lease edge (+999ms, +1000ms)"] = [
      await claimAt(0, 1),
      await claimAt(999, 5),
      await claimAt(1000, 5),
      await claimAt(1999, 5),
      await claimAt(2000, 5),
    ];
  }
  {
    // リースが切れた行の取り直しは `availableAt` を claim の時刻へ進め、待ち行列の後ろへ回す（ADR 0357）
    const ctx = fresh();
    await seedJobs(ctx, "embed");
    const at = Date.now() + 60_000;
    const labels = new Map<string, string>();
    const claimAt = async (offset: number, limit: number) =>
      (
        await ob.claimBatch(ctx, {
          limit,
          now: new Date(at + offset),
          claimedBy: "w",
          leaseMs: 1000,
          kinds: ["embed"],
        })
      )
        .map((j) => {
          if (!labels.has(j.id)) labels.set(j.id, `job ${labels.size + 1}`);
          const moved = j.availableAt.getTime() - at;
          return [labels.get(j.id), j.attempts, moved >= 0 ? moved : "as seeded"];
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out["claim: a re-claim after the lease moves availableAt to now and the row to the tail"] = [
      await claimAt(0, 1),
      await claimAt(5000, 2),
      await claimAt(10000, 1),
      await claimAt(15000, 1),
    ];
  }
  {
    // 取り直しの候補だったが `limit` で落ちた行の `availableAt` は変わらない（ADR 0357: 書き直すのは、取り直した行だけ）。
    // 4件を積んだ順に1件ずつ claim し（リースは 5000 までに切れる）、5000 で1件だけ取り直す（job 1）。落ちた job 2〜4 は候補だった
    // が、積んだままの古い `availableAt` を保つ。7000 の claim は、まず job 2〜4（積んだ順）を取り、そのあと 5000 に進んだ job 1 を取る。
    // 落ちた行まで 5000 に進める実装では、4件が 5000 で並び、7000 の最初の claim が job 1 になる。
    const ctx = fresh();
    await seedJobs(ctx, "embed");
    await seedJobs(ctx, "embed");
    const at = Date.now() + 60_000;
    const labels = new Map<string, string>();
    const claimAt = async (offset: number, limit: number) =>
      (
        await ob.claimBatch(ctx, {
          limit,
          now: new Date(at + offset),
          claimedBy: "w",
          leaseMs: 1000,
          kinds: ["embed"],
        })
      )
        .map((j) => {
          if (!labels.has(j.id)) labels.set(j.id, `job ${labels.size + 1}`);
          const moved = j.availableAt.getTime() - at;
          return [labels.get(j.id), j.attempts, moved >= 0 ? moved : "as seeded"];
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out[
      "claim: a candidate dropped by limit keeps its availableAt, only the re-claimed row moves"
    ] = [
      await claimAt(0, 1),
      await claimAt(0, 1),
      await claimAt(0, 1),
      await claimAt(0, 1),
      await claimAt(5000, 1),
      await claimAt(7000, 1),
      await claimAt(7000, 1),
      await claimAt(7000, 1),
      await claimAt(7000, 1),
    ];
  }
  return out;
}

let clockOffsetMs = 0;
const calls = { llm: 0, embed: 0 };
const gates: {
  llm: ((n: number) => Promise<void>) | null;
  embed: ((n: number) => Promise<void>) | null;
} = {
  llm: null,
  embed: null,
};
let llmOverride: ((n: number) => Array<{ content: string }> | null) | null = null;
const llm = {
  name: "canned",
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    const n = (calls.llm += 1); // 門の中で別の tick が呼ぶので、自分の番号を先に控える
    if (gates.llm) await gates.llm(n);
    const override = llmOverride?.(n);
    const extracted = override ?? [{ content: "extracted fact" }];
    return req.schema.parse({
      outcome: "reflected",
      content: "CANNED merged",
      digest: "canned digest",
      tags: [],
      memories: extracted.map((m) => ({
        content: m.content,
        digest: m.content,
        provenanceKind: "stated",
        confidence: 1,
      })),
    }) as T;
  },
};
const embedding = (space: { provider: string; model: string; dimensions: number }) => ({
  space,
  embed: async (_ctx: Ctx, texts: string[]) => {
    const n = (calls.embed += 1);
    if (gates.embed) await gates.embed(n);
    // "g2" を含む文は別の向き（2つ目のグループ）にする
    return texts.map((t) => (/g2/.test(t) ? [0, 1, 0] : [1, 0, 0]));
  },
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function seedJobsWith(
  ctx: Ctx,
  kind: Kind,
  io: {
    createWithOutbox: (
      ctx: Ctx,
      content: string,
      kinds: string[],
      pending: boolean,
    ) => Promise<{ id: string }>;
    createPlain: (ctx: Ctx, content: string) => Promise<{ id: string }>;
    upsertVector: (ctx: Ctx, id: string, vec: number[]) => Promise<void>;
    createObservation: (ctx: Ctx, externalId: string) => Promise<{ id: string }>;
  },
): Promise<{ observationIds: string[]; seedIds: string[] }> {
  return (async () => {
    const observationIds: string[] = [];
    const seedIds: string[] = [];
    if (kind === "extract") {
      for (const e of ["e1", "e2"]) {
        observationIds.push((await io.createObservation(ctx, e)).id);
        await sleep(3);
      }
      return { observationIds, seedIds };
    }
    for (const i of [1, 2]) {
      const g = i === 2 ? "g2 " : "";
      const vec = i === 2 ? [0, 1, 0] : [1, 0, 0];
      const seed = await io.createWithOutbox(
        ctx,
        `banana ${g}${kind} seed ${i}`,
        [kind],
        kind === "embed",
      );
      seedIds.push(seed.id);
      if (kind !== "embed") await io.upsertVector(ctx, seed.id, vec);
      await sleep(3);
      if (kind === "consolidate" || kind === "reflect") {
        for (const j of [1, 2]) {
          const nb = await io.createPlain(ctx, `banana ${g}neighbor ${j}`);
          await io.upsertVector(ctx, nb.id, vec);
        }
      }
    }
    return { observationIds, seedIds };
  })();
}

const EXPECTED: Result = {
  "embed: A's job 2 outlives the lease and B re-claims it": {
    fired: true,
    A: [1, 0, 0, [["embed", "complete"]]],
    B: [1, 0, 0, []],
    calls: {
      llm: 0,
      embed: 3,
    },
    rows: [
      ["embed", 1, true, false],
      ["embed", 2, true, false],
    ],
    events: [],
  },
  "embed: A's job 2 outlives the lease and nobody re-claims it": {
    fired: true,
    A: [2, 0, 0, []],
    B: null,
    calls: {
      llm: 0,
      embed: 2,
    },
    rows: [
      ["embed", 1, true, false],
      ["embed", 1, true, false],
    ],
    events: [],
  },
  "extract: A's job 2 outlives the lease and B re-claims it": {
    fired: true,
    A: [1, 0, 0, [["extract", "complete"]]],
    B: [1, 0, 0, []],
    calls: {
      llm: 3,
      embed: 0,
    },
    rows: [
      ["consolidate", 0, false, false],
      ["consolidate", 0, false, false],
      ["embed", 0, false, false],
      ["embed", 0, false, false],
      ["extract", 1, true, false],
      ["extract", 2, true, false],
      ["reflect", 0, false, false],
      ["reflect", 0, false, false],
    ],
    events: ["created", "created"],
  },
  "extract: A's job 2 outlives the lease and nobody re-claims it": {
    fired: true,
    A: [2, 0, 0, []],
    B: null,
    calls: {
      llm: 2,
      embed: 0,
    },
    rows: [
      ["consolidate", 0, false, false],
      ["consolidate", 0, false, false],
      ["embed", 0, false, false],
      ["embed", 0, false, false],
      ["extract", 1, true, false],
      ["extract", 1, true, false],
      ["reflect", 0, false, false],
      ["reflect", 0, false, false],
    ],
    events: ["created", "created"],
  },
  "consolidate: A's job 2 outlives the lease and B re-claims it": {
    fired: true,
    A: [1, 0, 0, [["consolidate", "complete"]]],
    B: [1, 0, 0, []],
    calls: {
      llm: 3,
      embed: 3,
    },
    rows: [
      ["consolidate", 1, true, false],
      ["consolidate", 2, true, false],
      ["embed", 0, false, false],
      ["embed", 0, false, false],
    ],
    events: [
      "created",
      "created",
      "superseded",
      "superseded",
      "superseded",
      "superseded",
      "superseded",
      "superseded",
    ],
  },
  "consolidate: A's job 2 outlives the lease and nobody re-claims it": {
    fired: true,
    A: [2, 0, 0, []],
    B: null,
    calls: {
      llm: 2,
      embed: 2,
    },
    rows: [
      ["consolidate", 1, true, false],
      ["consolidate", 1, true, false],
      ["embed", 0, false, false],
      ["embed", 0, false, false],
    ],
    events: [
      "created",
      "created",
      "superseded",
      "superseded",
      "superseded",
      "superseded",
      "superseded",
      "superseded",
    ],
  },
  "reflect: A's job 2 outlives the lease and B re-claims it": {
    fired: true,
    A: [1, 0, 0, [["reflect", "complete"]]],
    B: [1, 0, 0, []],
    calls: {
      llm: 3,
      embed: 3,
    },
    rows: [
      ["embed", 0, false, false],
      ["embed", 0, false, false],
      ["embed", 0, false, false],
      ["reflect", 1, true, false],
      ["reflect", 2, true, false],
    ],
    events: ["created", "created", "created"],
  },
  "reflect: A's job 2 outlives the lease and nobody re-claims it": {
    fired: true,
    A: [2, 0, 0, []],
    B: null,
    calls: {
      llm: 2,
      embed: 2,
    },
    rows: [
      ["embed", 0, false, false],
      ["embed", 0, false, false],
      ["reflect", 1, true, false],
      ["reflect", 1, true, false],
    ],
    events: ["created", "created"],
  },
  "extract doubled (same candidate): memories per observation": [
    [1, 0, 0, [["extract", "complete"]]],
    [1, 0, 0, []],
    [[["extracted fact", "active"]], [["shared fact", "active"]]],
  ],
  "extract doubled (different candidates): memories per observation": [
    [1, 0, 0, [["extract", "complete"]]],
    [1, 0, 0, []],
    [
      [["extracted fact", "active"]],
      [
        ["A fact", "active"],
        ["B fact", "active"],
      ],
    ],
  ],
  "extract doubled (A's LLM fails late after B completed): memories per observation": [
    [1, 0, 0, [["extract", "complete"]]],
    [1, 0, 0, []],
    [
      [["extracted fact", "active"]],
      [
        ["B fact", "active"],
        ["I like bananas e2", "active"],
      ],
    ],
  ],
  "reflect doubled: reflected memories and the seeds' status": [
    [3, 3, 3],
    ["active", "active"],
  ],
  "claim: limit below the row count, then the lease edge (+999ms, +1000ms)": [
    [1],
    [1],
    [2],
    [2],
    [3],
  ],
  "claim: a re-claim after the lease moves availableAt to now and the row to the tail": [
    [["job 1", 1, "as seeded"]],
    [
      ["job 1", 2, 5000],
      ["job 2", 1, "as seeded"],
    ],
    [["job 2", 2, 10000]],
    [["job 1", 3, 15000]],
  ],
  "claim: a candidate dropped by limit keeps its availableAt, only the re-claimed row moves": [
    [["job 1", 1, "as seeded"]],
    [["job 2", 1, "as seeded"]],
    [["job 3", 1, "as seeded"]],
    [["job 4", 1, "as seeded"]],
    [["job 1", 2, 5000]],
    [["job 2", 2, 7000]],
    [["job 3", 2, 7000]],
    [["job 4", 2, 7000]],
    [["job 1", 3, 7000]],
  ],
};

let hashCounter = 0;
function newMemory(ctx: Ctx, content: string, pending: boolean): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `batch-lease-${hashCounter}`,
    digest: content,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date(),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365,
    decayFloorAt: new Date("2035-01-01T00:00:00.000Z"),
    embeddingStatus: pending ? "pending" : "ready",
  };
}

describe("1回の tick の2件目の処理中にリースが切れたとき、別の tick が再 claim した結末（Fake）", () => {
  it("embed・extract・consolidate・reflect それぞれで、2件目の処理中にリースが切れて別の tick が再 claim したときの結末が、Postgres で実測した値（EXPECTED）と一致する", async () => {
    const stores = createFakeRuntimeStores();
    const space = { provider: "fake", model: "fake-model", dimensions: 3 };
    clockOffsetMs = 0;
    calls.llm = 0;
    calls.embed = 0;
    gates.llm = null;
    gates.embed = null;
    llmOverride = null;
    const runtime: Runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      lexicalStore: stores.lexicalStore,
      eventStore: stores.eventStore,
      relationStore: stores.relationStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm,
      embeddingProvider: embedding(space),
      hashContent: (content) => `h(${content})`,
      clock: { now: () => new Date(Date.now() + clockOffsetMs) },
      config: { autoQueueConsolidateReflectOnExtract: true },
    });
    const toRow = (j: OutboxJobRecord) => ({
      kind: j.kind,
      attempts: j.attempts,
      done: j.completedAt != null,
      failed: j.failedAt != null,
    });
    let n = 0;
    const out = await scenario({
      runtime,
      mem: stores.memoryStore as MemoryStore,
      ev: stores.eventStore as EventStore,
      ob: stores.outboxStore as OutboxStore,
      rows: async (ctx) => stores.outboxStore.listJobs(ctx).map(toRow),
      fresh: () => ({ tenantId: `batch-lease-fake-${(n += 1)}` }),
      seedJobs: (ctx, kind) =>
        seedJobsWith(ctx, kind, {
          createWithOutbox: async (c, content, kinds, pending) =>
            (
              await stores.memoryStore.createMemoryWithOutbox(
                c,
                newMemory(c, content, pending),
                kinds,
              )
            ).memory,
          createPlain: (c, content) =>
            stores.memoryStore.createMemory(c, newMemory(c, content, false)),
          upsertVector: (c, id, vec) => stores.vectorStore.upsert(c, space, id, vec),
          createObservation: async (c, externalId) =>
            (
              await stores.memoryStore.createObservationWithOutbox(
                c,
                {
                  tenantId: c.tenantId,
                  subjectId: null,
                  externalId,
                  kind: "utterance",
                  payload: { text: `I like bananas ${externalId}` },
                  occurredAt: null,
                },
                ["extract"],
              )
            ).observation,
        }),
      setClockOffset: (ms) => {
        clockOffsetMs = ms;
      },
      setGate: (provider, gate) => {
        gates[provider] = gate;
      },
      setLlmOverride: (fn) => {
        llmOverride = fn;
      },
      takeCalls: () => {
        const v = { ...calls };
        calls.llm = 0;
        calls.embed = 0;
        return v;
      },
    });
    expect(out).toEqual(EXPECTED);
  });
});

describe("TickOptions.leaseMs の TSDoc — 二重に走った結末が種類で違うことを書いてある（ADR 0530）", () => {
  it("embed・extract・reflect・consolidate の結末と、遅れた側が leaseConflicts に載ることを名指ししている", () => {
    const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
    const start = source.indexOf("export interface TickOptions {");
    const end = source.indexOf("\n  leaseMs: number;", start);
    const doc = source.slice(start, end);
    expect(doc).toContain("二重に走った結末は種類で違う");
    expect(doc).toContain("内省の記憶が2件できる");
    expect(doc).toContain("統合先は1件のまま");
    expect(doc).toContain("両方が `active` で残る");
  });
});
