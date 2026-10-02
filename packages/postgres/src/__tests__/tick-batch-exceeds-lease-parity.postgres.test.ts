import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventStore,
  MemoryStore,
  OutboxStore,
  Runtime,
  StructuredRequest,
  TickResult,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryRelationStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ADR 0530: 1回の `tick` の2件目の処理中にリースが切れたとき、別の `tick` が再 claim して二重に処理した結末を、種類ごと（embed・extract・
 * consolidate・reflect）に、**実 Postgres と InMemory の両方**で `EXPECTED` に突き合わせる。core の Fake の側は
 * `packages/core/src/__tests__/fake-tick-batch-exceeds-lease-parity.test.ts` が同じ `EXPECTED` を縛る。
 * 順序は時計のオフセットと provider の前の門（Promise）で決める（実時間は待たない）。DB はファイル冒頭で作り直し、tenant はこのファイル専用の名前を使う。
 */
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ev: EventStore;
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
 * ADR 0530: 1回の `tick` が claim した2件のうち、2件目の処理中にリースが切れる（バッチの claim 時点から数えるので、1件あたりの処理が
 * `leaseMs` より短くても起きる。`TickOptions.leaseMs` の TSDoc）。順序は時計のオフセットと provider の前の門（Promise）で決める:
 * A の2件目が provider の門に着いたところで時計を進め、(1) 別の `tick` B が2件目を再 claim して最後まで処理する／(2) 誰も取り直さない、
 * のあと A の門を開ける。種類ごとに、二重に走った結末を比べる。
 */
async function scenario(env: Env): Promise<Result> {
  const {
    runtime,
    mem,
    ev,
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
  // extract: 二重に処理された observation の結末
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
    // A の LLM が、B が完了したあとで落ちる（全文のフォールバックで書く）
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
  // reflect: 二重に処理された種から、内省の記憶がいくつできるか
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
      // reflect・consolidate・extract のどの schema にも通る、決め打ちの応答（LLM の実 API は使わない）
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
};
const space = TEST_EMBEDDING_SPACE;

afterAll(async () => {
  await closeTestClient();
});

let hashCounter = 0;
function fixture(ctx: Ctx, content: string, pending: boolean) {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `batch-lease-${hashCounter}`,
    content,
    digest: content,
    embeddingStatus: pending ? "pending" : "ready",
    recordedAt: new Date(),
    halfLifeHours: 24 * 365,
    decayFloorAt: new Date("2035-01-01T00:00:00.000Z"),
  });
}

type Stores = {
  mem: MemoryStore;
  vec: PostgresVectorStore | InMemoryVectorStore;
  lex: PostgresLexicalStore | InMemoryLexicalStore;
  ev: EventStore;
  ob: OutboxStore;
  ts: PostgresTenantSettingsStore | InMemoryTenantSettingsStore;
  rel: PostgresRelationStore | InMemoryRelationStore;
};

function build(base: string, stores: Stores, rows: Env["rows"]): Env {
  clockOffsetMs = 0;
  calls.llm = 0;
  calls.embed = 0;
  gates.llm = null;
  gates.embed = null;
  llmOverride = null;
  const runtime: Runtime = createRuntime({
    memoryStore: stores.mem,
    vectorStore: stores.vec,
    lexicalStore: stores.lex,
    outboxStore: stores.ob,
    eventStore: stores.ev,
    relationStore: stores.rel,
    tenantSettingsStore: stores.ts,
    llmProvider: llm,
    embeddingProvider: embedding(space),
    hashContent: (content) => `h(${content})`,
    clock: { now: () => new Date(Date.now() + clockOffsetMs) },
    config: { autoQueueConsolidateReflectOnExtract: true },
  });
  let n = 0;
  return {
    runtime,
    mem: stores.mem,
    ev: stores.ev,
    rows,
    fresh: () => ({ tenantId: `${base}-${(n += 1)}` }),
    seedJobs: (ctx, kind) =>
      seedJobsWith(ctx, kind, {
        createWithOutbox: async (c, content, kinds, pending) =>
          (await stores.mem.createMemoryWithOutbox(c, fixture(c, content, pending), kinds)).memory,
        createPlain: (c, content) => stores.mem.createMemory(c, fixture(c, content, false)),
        upsertVector: (c, id, vec) => stores.vec.upsert(c, space, id, vec),
        createObservation: async (c, externalId) =>
          (
            await stores.mem.createObservationWithOutbox(
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
  };
}

describe("1回の tick の2件目の処理中にリースが切れたとき、別の tick が再 claim した結末（InMemory・Postgres）", () => {
  it("InMemory は Postgres で実測した結果（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    const env = build(
      "batch-lease-inmem",
      {
        mem: m,
        vec: new InMemoryVectorStore(m),
        lex: new InMemoryLexicalStore(m),
        ev: new InMemoryEventStore(m, m.events),
        ob: new InMemoryOutboxStore(m.outboxJobs),
        ts: new InMemoryTenantSettingsStore(
          m.activitySeq,
          m.subjectActivitySeq,
          m.eventRetentionDays,
        ),
        rel: new InMemoryRelationStore(m),
      },
      async (ctx) =>
        m.outboxJobs
          .filter((j) => j.tenantId === ctx.tenantId)
          .map((j) => ({
            kind: j.kind,
            attempts: j.attempts,
            done: j.completedAt != null,
            failed: j.failedAt != null,
          })),
    );
    expect(await scenario(env)).toEqual(EXPECTED);
  });

  it("Postgres は EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const env = build(
      "batch-lease-pg",
      {
        mem: new PostgresMemoryStore(db),
        vec: new PostgresVectorStore(db),
        lex: new PostgresLexicalStore(db),
        ev: new PostgresEventStore(db),
        ob: new PostgresOutboxStore(db),
        ts: new PostgresTenantSettingsStore(db),
        rel: new PostgresRelationStore(db),
      },
      async (ctx) => {
        const r = await db.execute(sql`
          SELECT kind, attempts, completed_at IS NOT NULL AS done, failed_at IS NOT NULL AS failed
          FROM outbox WHERE tenant_id = ${ctx.tenantId} ORDER BY created_at, kind
        `);
        return r.rows as Array<Record<string, unknown>>;
      },
    );
    expect(await scenario(env)).toEqual(EXPECTED);
  });
});
