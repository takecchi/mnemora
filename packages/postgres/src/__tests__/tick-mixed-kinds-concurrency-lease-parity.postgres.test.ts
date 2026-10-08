import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventStore,
  Memory,
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
 * `tick` が `extract`・`embed`・`consolidate`・`reflect` を混ぜて回るとき、並行する複数の `tick`、リースが切れた後の再取得を、
 * **実 Postgres と InMemory の両方**で `EXPECTED` に突き合わせる。
 * 順序は時計のオフセットと門（Promise）で決める。並行する `tick` の「どちらが何件取るか」は Postgres の実の並行で転ぶので縛らず、
 * どう転んでも成り立つ不変条件だけを縛る。テスト用の DB はこのファイルの冒頭で作り直す（`resetTestDatabase`）。
 */
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ev: EventStore;
  ob: OutboxStore;
  rows: (ctx: Ctx) => Promise<Array<Record<string, unknown>>>;
  /** 記憶を作り、`kinds` のジョブ（payload は `{ memoryId }`）を積む。`ready` ならベクトルも入れる。 */
  seed: (ctx: Ctx, content: string, kinds: string[], ready: boolean) => Promise<Memory>;
  /** `utterance` の observation を作り、`extract` のジョブを積む。 */
  seedExtract: (ctx: Ctx, externalId: string) => Promise<void>;
  /** 時計を壁時計から `ms` だけ進める（`RuntimeDeps.clock`）。 */
  setClockOffset: (ms: number) => void;
  /** そのテナントの、その種類のジョブの `available_at` を直に書き換える（挿入順と食い違う状態を作る）。実装ごとの内部の口で作る。 */
  setAvailableAt: (ctx: Ctx, kind: string, at: Date) => Promise<void>;
  /** embed の呼び出しの前に走る門。`null` で外す。 */
  setEmbedGate: (gate: ((n: number) => Promise<void>) | null) => void;
  /** これまでの embed の呼び出し回数を返して、0 に戻す。 */
  takeEmbedCalls: () => number;
  fresh: () => Ctx;
}

type Result = Record<string, unknown>;

/**
 * `tick` が `extract`・`embed`・`consolidate`・`reflect` を混ぜて回るとき、および並行する複数の `tick` と、
 * リースが切れた後の再取得（Runtime の層）。
 *
 * 決定的にできる部分だけを縛る。順序は時計（`setClockOffset`）と門（Promise）で決める。
 * 並行する `tick` の「どちらが何件取るか」は Postgres の実の並行で転ぶので縛らず、**どう転んでも成り立つ不変条件**
 * （全件が1回ずつ処理される・リース競合が無い・embed の呼び出しが件数と同じ）だけを縛る。
 */
async function scenario(env: Env): Promise<Result> {
  const {
    runtime,
    ob,
    rows,
    seed,
    seedExtract,
    setClockOffset,
    setAvailableAt,
    setEmbedGate,
    takeEmbedCalls,
    fresh,
    mem,
  } = env;
  const out: Result = {};
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const T = (t: TickResult) => [
    t.processed,
    t.failed,
    t.unsupported.length,
    t.leaseConflicts.length,
  ];
  const canon = async (ctx: Ctx) =>
    (await rows(ctx))
      .map((r) => [r["kind"], r["attempts"], r["done"], r["failed"], r["last_error"]])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const inOrder = async (ctx: Ctx) =>
    (await rows(ctx)).map((r) => [r["kind"], r["done"], r["attempts"]]);

  {
    setClockOffset(0);
    const ctx = fresh();
    const e = await seed(ctx, "embed target", ["embed"], false);
    await sleep(5);
    await seedExtract(ctx, "x1");
    await sleep(5);
    await seed(ctx, "banana seed c", ["consolidate"], true);
    await sleep(5);
    await seed(ctx, "banana seed r", ["reflect"], true);
    takeEmbedCalls();
    const t1 = await runtime.tick(ctx, { leaseMs: 60_000 });
    const afterFirst = await canon(ctx);
    const calls1 = takeEmbedCalls();
    const t2 = await runtime.tick(ctx, { leaseMs: 60_000 });
    const t3 = await runtime.tick(ctx, { leaseMs: 60_000 });
    out["mixed kinds: one tick takes all four kinds, follow-up jobs wait for the next tick"] = [
      T(t1),
      afterFirst,
      calls1,
      T(t2),
      T(t3),
      await canon(ctx),
      (await mem.get(ctx, e.id))?.embeddingStatus,
    ];
  }
  {
    setClockOffset(0);
    const ctx = fresh();
    for (const k of ["embed", "consolidate", "reflect", "embed"]) {
      await seed(ctx, `m ${k}`, [k], k !== "embed");
      await sleep(5);
    }
    const t1 = await runtime.tick(ctx, { leaseMs: 60_000, limit: 2 });
    const a = await inOrder(ctx);
    const t2 = await runtime.tick(ctx, { leaseMs: 60_000, limit: 2 });
    out["mixed kinds: limit 2 takes the two oldest regardless of kind"] = [
      T(t1),
      a,
      T(t2),
      await inOrder(ctx),
    ];
  }
  {
    setClockOffset(0);
    const ctx = fresh();
    await seed(ctx, "e", ["embed"], false);
    await sleep(5);
    await seed(ctx, "banana c", ["consolidate"], true);
    await sleep(5);
    await seed(ctx, "banana r", ["reflect"], true);
    const t = await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["embed", "extract"] });
    out["mixed kinds: kinds [embed, extract] leaves consolidate and reflect untouched"] = [
      T(t),
      await inOrder(ctx),
    ];
  }
  {
    setClockOffset(0);
    const ctx = fresh();
    await seed(ctx, "e", ["embed", "custom-kind"], false);
    const t1 = await runtime.tick(ctx, { leaseMs: 60_000 });
    const a = await canon(ctx);
    const t2 = await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["custom-kind"] });
    out["mixed kinds: an unknown kind is left alone by default and fails terminally when named"] = [
      T(t1),
      a,
      T(t2),
      await canon(ctx),
    ];
  }

  for (const [label, limits, delay] of [
    ["2 ticks, limit 3 and 3", [3, 3], 0],
    ["2 ticks, limit 50 and 50", [50, 50], 0],
    ["3 ticks, limit 50, slow handler", [50, 50, 50], 20],
  ] as Array<[string, number[], number]>) {
    setClockOffset(0);
    const ctx = fresh();
    const n = 6;
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push((await seed(ctx, `embed ${i}`, ["embed"], false)).id);
    takeEmbedCalls();
    setEmbedGate(delay ? () => sleep(delay) : null);
    let ts: TickResult[];
    try {
      ts = await Promise.all(limits.map((limit) => runtime.tick(ctx, { leaseMs: 60_000, limit })));
    } finally {
      setEmbedGate(null);
    }
    const r = await rows(ctx);
    const ms = await Promise.all(ids.map((id) => mem.get(ctx, id)));
    const total = ts.reduce((s, t) => s + t.processed, 0);
    const cap = limits.reduce((s, l) => s + l, 0);
    out[`concurrent ticks (${label}): every job once, no conflicts`] = {
      processedWithinBounds: total >= 1 && total <= Math.min(cap, n),
      failed: ts.reduce((s, t) => s + t.failed, 0),
      leaseConflicts: ts.reduce((s, t) => s + t.leaseConflicts.length, 0),
      embedCallsEqualProcessed: takeEmbedCalls() === total,
      noJobClaimedTwice: r.every((x) => (x["attempts"] as number) <= 1),
      unprocessedLeftUntouched:
        r.filter((x) => x["attempts"] === 0 && x["done"] === false).length === n - total,
      ready: ms.filter((m) => m?.embeddingStatus === "ready").length === total,
    };
  }

  for (const lateOutcome of ["complete", "fail"] as const) {
    setClockOffset(0);
    const ctx = fresh();
    const [job] = [await seed(ctx, "embed", ["embed"], false)];
    takeEmbedCalls();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    setEmbedGate(async (n) => {
      if (n !== 1) return;
      entered();
      await gate;
      if (lateOutcome === "fail") throw new Error("A's provider died late");
    });
    try {
      const aP = runtime.tick(ctx, { leaseMs: 1000 });
      await enteredP;
      const before = (await rows(ctx)).map((r) => [r["attempts"], r["claimed"], r["done"]]);
      const withinLease = await runtime.tick(ctx, { leaseMs: 1000 });
      setClockOffset(5000);
      const bT = await runtime.tick(ctx, { leaseMs: 1000 });
      const mid = (await rows(ctx)).map((r) => [r["attempts"], r["done"]]);
      release();
      const aT = await aP;
      setClockOffset(0);
      out[`lease expiry: A stalls, B takes over, A ${lateOutcome}s late`] = {
        before,
        withinLease: T(withinLease),
        B: T(bT),
        mid,
        A: T(aT),
        aConflict: aT.leaseConflicts.map((x) => [x.kind, x.attemptedOutcome]),
        end: await canon(ctx),
        embedCalls: takeEmbedCalls(),
        memory: (await mem.get(ctx, job.id))?.embeddingStatus,
      };
    } finally {
      setEmbedGate(null);
      setClockOffset(0);
    }
  }
  {
    setClockOffset(0);
    const ctx = fresh();
    await seed(ctx, "embed", ["embed"], false);
    const claimed = await ob.claimBatch(ctx, {
      limit: 5,
      now: new Date(),
      claimedBy: "dead-worker",
      leaseMs: 1000,
    });
    const within = await runtime.tick(ctx, { leaseMs: 1000 });
    setClockOffset(1500);
    const after = await runtime.tick(ctx, { leaseMs: 1000 });
    setClockOffset(0);
    out["lease expiry: a dead worker's claim is taken over by the next tick after the lease"] = {
      claimed: claimed.length,
      within: T(within),
      after: T(after),
      rows: await canon(ctx),
    };
  }
  {
    setClockOffset(0);
    const ctx = fresh();
    await seed(ctx, "embed", ["embed"], false);
    const claimedAt = (
      await ob.claimBatch(ctx, { limit: 5, now: new Date(), claimedBy: "w", leaseMs: 1000 })
    )[0]!.claimedAt!;
    out["lease expiry: reclaimable exactly at claimedAt + leaseMs, not 1ms before"] = [
      (
        await ob.claimBatch(ctx, {
          limit: 5,
          now: new Date(claimedAt.getTime() + 999),
          claimedBy: "x",
          leaseMs: 1000,
        })
      ).length,
      (
        await ob.claimBatch(ctx, {
          limit: 5,
          now: new Date(claimedAt.getTime() + 1000),
          claimedBy: "x",
          leaseMs: 1000,
        })
      ).length,
    ];
  }
  {
    // 挿入順と `available_at` 順が食い違うジョブ、大文字小文字だけ違う kind
    setClockOffset(0);
    const ctx = fresh();
    await seed(ctx, "order a", ["embed"], false);
    await sleep(5);
    await seed(ctx, "order b", ["consolidate"], false);
    await sleep(5);
    await seed(ctx, "order c", ["reflect"], false);
    await sleep(5);
    const base = Date.now();
    await setAvailableAt(ctx, "consolidate", new Date(base - 1000));
    const claimOne = async () =>
      (
        await ob.claimBatch(ctx, {
          limit: 1,
          now: new Date(base + 1000),
          claimedBy: "w",
          leaseMs: 60_000,
        })
      ).map((j) => [j.kind, j.attempts]);
    out["claim order: the oldest available_at goes first, not the first inserted"] = [
      await claimOne(),
      await claimOne(),
      await claimOne(),
      await claimOne(),
    ];
    const upperCtx = fresh();
    await seed(upperCtx, "upper a", ["Custom-Kind"], false);
    await seed(upperCtx, "upper b", ["custom-kind"], false);
    const claimKinds = async (kinds: string[]) =>
      (
        await ob.claimBatch(upperCtx, {
          limit: 5,
          now: new Date(base + 10_000),
          claimedBy: "w",
          leaseMs: 1000,
          kinds,
        })
      )
        .map((j) => [j.kind, j.attempts])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out["claim kinds: a kind that differs only in case is a different kind"] = [
      await claimKinds(["CUSTOM-KIND"]),
      await claimKinds(["custom-kind"]),
      await claimKinds(["Custom-Kind"]),
      await claimKinds(["custom-kind", "Custom-Kind"]),
    ];
  }
  return out;
}

const extractedContent = "extracted fact";
const llm = {
  name: "canned",
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({
      // reflect・consolidate・extract のどの schema にも通る、決め打ちの応答（LLM の実 API は使わない）
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

/** 時計（壁時計 + オフセット）・embed の呼び出し回数・embed の前の門。 */
let clockOffsetMs = 0;
let embedCalls = 0;
let embedGate: ((n: number) => Promise<void>) | null = null;
const embedding = (space: { provider: string; model: string; dimensions: number }) => ({
  space,
  embed: async (_ctx: Ctx, texts: string[]) => {
    embedCalls += 1;
    if (embedGate) await embedGate(embedCalls);
    return texts.map(() => [1, 0, 0]);
  },
});

const EXPECTED: Result = {
  "mixed kinds: one tick takes all four kinds, follow-up jobs wait for the next tick": [
    [4, 0, 0, 0],
    [
      ["consolidate", 0, false, false, null],
      ["consolidate", 1, true, false, null],
      ["embed", 0, false, false, null],
      ["embed", 0, false, false, null],
      ["embed", 1, true, false, null],
      ["extract", 1, true, false, null],
      ["reflect", 0, false, false, null],
      ["reflect", 1, true, false, null],
    ],
    3,
    [4, 0, 0, 0],
    [1, 0, 0, 0],
    [
      ["consolidate", 1, true, false, null],
      ["consolidate", 1, true, false, null],
      ["embed", 1, true, false, null],
      ["embed", 1, true, false, null],
      ["embed", 1, true, false, null],
      ["embed", 1, true, false, null],
      ["extract", 1, true, false, null],
      ["reflect", 1, true, false, null],
      ["reflect", 1, true, false, null],
    ],
    "ready",
  ],
  "mixed kinds: limit 2 takes the two oldest regardless of kind": [
    [2, 0, 0, 0],
    [
      ["embed", true, 1],
      ["consolidate", true, 1],
      ["reflect", false, 0],
      ["embed", false, 0],
    ],
    [2, 0, 0, 0],
    [
      ["embed", true, 1],
      ["consolidate", true, 1],
      ["reflect", true, 1],
      ["embed", true, 1],
      ["embed", false, 0],
    ],
  ],
  "mixed kinds: kinds [embed, extract] leaves consolidate and reflect untouched": [
    [1, 0, 0, 0],
    [
      ["embed", true, 1],
      ["consolidate", false, 0],
      ["reflect", false, 0],
    ],
  ],
  "mixed kinds: an unknown kind is left alone by default and fails terminally when named": [
    [1, 0, 0, 0],
    [
      ["custom-kind", 0, false, false, null],
      ["embed", 1, true, false, null],
    ],
    [0, 1, 1, 0],
    [
      ["custom-kind", 1, false, true, "runtime.tick: unsupported outbox job kind: custom-kind"],
      ["embed", 1, true, false, null],
    ],
  ],
  "concurrent ticks (2 ticks, limit 3 and 3): every job once, no conflicts": {
    processedWithinBounds: true,
    failed: 0,
    leaseConflicts: 0,
    embedCallsEqualProcessed: true,
    noJobClaimedTwice: true,
    unprocessedLeftUntouched: true,
    ready: true,
  },
  "concurrent ticks (2 ticks, limit 50 and 50): every job once, no conflicts": {
    processedWithinBounds: true,
    failed: 0,
    leaseConflicts: 0,
    embedCallsEqualProcessed: true,
    noJobClaimedTwice: true,
    unprocessedLeftUntouched: true,
    ready: true,
  },
  "concurrent ticks (3 ticks, limit 50, slow handler): every job once, no conflicts": {
    processedWithinBounds: true,
    failed: 0,
    leaseConflicts: 0,
    embedCallsEqualProcessed: true,
    noJobClaimedTwice: true,
    unprocessedLeftUntouched: true,
    ready: true,
  },
  "lease expiry: A stalls, B takes over, A completes late": {
    before: [[1, true, false]],
    withinLease: [0, 0, 0, 0],
    B: [1, 0, 0, 0],
    mid: [[2, true]],
    A: [0, 0, 0, 1],
    aConflict: [["embed", "complete"]],
    end: [["embed", 2, true, false, null]],
    embedCalls: 2,
    memory: "ready",
  },
  "lease expiry: A stalls, B takes over, A fails late": {
    before: [[1, true, false]],
    withinLease: [0, 0, 0, 0],
    B: [1, 0, 0, 0],
    mid: [[2, true]],
    A: [0, 0, 0, 1],
    aConflict: [["embed", "fail"]],
    end: [["embed", 2, true, false, null]],
    embedCalls: 2,
    memory: "ready",
  },
  "lease expiry: a dead worker's claim is taken over by the next tick after the lease": {
    claimed: 1,
    within: [0, 0, 0, 0],
    after: [1, 0, 0, 0],
    rows: [["embed", 2, true, false, null]],
  },
  "lease expiry: reclaimable exactly at claimedAt + leaseMs, not 1ms before": [0, 1],
  "claim order: the oldest available_at goes first, not the first inserted": [
    [["consolidate", 1]],
    [["embed", 1]],
    [["reflect", 1]],
    [],
  ],
  "claim kinds: a kind that differs only in case is a different kind": [
    [],
    [["custom-kind", 1]],
    [["Custom-Kind", 1]],
    [],
  ],
};
const space = TEST_EMBEDDING_SPACE;

afterAll(async () => {
  await closeTestClient();
});

let hashCounter = 0;
function fixture(ctx: Ctx, content: string, ready: boolean) {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `tick-mixed-${hashCounter}`,
    content,
    digest: content,
    embeddingStatus: ready ? "ready" : "pending",
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
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

function build(
  base: string,
  stores: Stores,
  rows: Env["rows"],
  setAvailableAt: Env["setAvailableAt"],
): Env {
  clockOffsetMs = 0;
  embedCalls = 0;
  embedGate = null;
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
    ob: stores.ob,
    rows,
    setAvailableAt,
    fresh: () => ({ tenantId: `${base}-${(n += 1)}` }),
    seed: async (ctx, content, kinds, ready): Promise<Memory> => {
      const { memory } = await stores.mem.createMemoryWithOutbox(
        ctx,
        fixture(ctx, content, ready),
        kinds,
      );
      if (ready) await stores.vec.upsert(ctx, space, memory.id, [1, 0, 0]);
      return memory;
    },
    seedExtract: async (ctx, externalId) => {
      await stores.mem.createObservationWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId,
          kind: "utterance",
          payload: { text: "I like bananas" },
          occurredAt: null,
        },
        ["extract"],
      );
    },
    setClockOffset: (ms) => {
      clockOffsetMs = ms;
    },
    setEmbedGate: (gate) => {
      embedGate = gate;
    },
    takeEmbedCalls: () => {
      const v = embedCalls;
      embedCalls = 0;
      return v;
    },
  };
}

describe("tick の種類の混在・並行・リースの期限切れ（InMemory・Postgres）", () => {
  it("InMemory の、種類が混在するジョブへの並行 tick と、リース期限切れ後の再 claim の結果が、Postgres で実測した値（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    const env = build(
      "tick-mixed-inmem",
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
            last_error: j.lastError,
            claimed: j.claimedBy != null,
          })),
      // InMemory は内部の行を直に書き換える。
      async (ctx, kind, at) => {
        for (const j of m.outboxJobs) {
          if (j.tenantId === ctx.tenantId && j.kind === kind) j.availableAt = new Date(at);
        }
      },
    );
    expect(await scenario(env)).toEqual(EXPECTED);
  });

  it("Postgres の、種類が混在するジョブへの並行 tick と、リース期限切れ後の再 claim の結果が、EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const env = build(
      "tick-mixed-pg",
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
          SELECT kind, attempts, completed_at IS NOT NULL AS done, failed_at IS NOT NULL AS failed,
                 last_error, claimed_by IS NOT NULL AS claimed
          FROM outbox WHERE tenant_id = ${ctx.tenantId} ORDER BY created_at, kind
        `);
        return r.rows as Array<Record<string, unknown>>;
      },
      // Postgres は SQL で書き換える。
      async (ctx, kind, at) => {
        await db.execute(sql`
          UPDATE outbox SET available_at = ${at.toISOString()}::timestamptz
          WHERE tenant_id = ${ctx.tenantId} AND kind = ${kind}
        `);
      },
    );
    expect(await scenario(env)).toEqual(EXPECTED);
  });
});
