import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  MemoryStore,
  Runtime,
  StructuredRequest,
  TenantSettingsStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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
 * ADR 0536（第1段の棚卸しの1つ目）: 活動時計（`decay_clock = "activity"`）の経路を Runtime の操作列で、**実 Postgres と InMemory の両方**で `EXPECTED` に
 * 突き合わせる。core の Fake の側は `packages/core/src/__tests__/fake-decay-activity-clock-parity.test.ts` が同じ `EXPECTED` を縛る。
 * DB はファイル冒頭で作り直し、tenant はこのファイル専用の名前を使う。
 */
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ts: TenantSettingsStore;
  fresh: () => Ctx;
  /** 抽出の LLM が次の `observe` で返す本文。 */
  setExtracted: (content: string) => void;
}

type Result = Record<string, unknown>;

/**
 * ADR 0536 の1つ目（活動時計 `decay_clock = "activity"` の経路）: Runtime の操作列を3者（core の Fake・testkit の InMemory・Postgres）に流し、
 * 記憶ごとの status と活動時計の3つ組（`decayBaseSeq`・`decayFloorSeq`・`halfLifeRecalls`）、`TenantSettingsStore` の活動の数（`T`・subject ごとの `S_x`）、
 * recall の結果（別名）、`sweepArchive`（`clock`: 既定のテナントの設定・`activity`・`either`・`wall`）の結果を、平らなデータにする。
 * subject なしの記憶と subject ありの記憶を混ぜ（ADR 0353・0394）、壁時計から活動時計へ切り替えた記憶（Issue #1014）も入れる。
 */
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
    return { ids: r.memories.map((m) => alias(m.memoryId)).sort(), recallId: r.recallId };
  };

  // 1. 活動時計のテナントで、subject なし・alice・bob の記憶を作る（半減期 3 回）
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

  // 2. 半減期 1 回の記憶（すぐ沈む）を、subject なし・alice で足す。カウンタが進んだあとに作るので、起点は T + S_x
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

  // 3. recall を重ねて活動の数を進める。各回の結果（忘却ゲートの後）と、カウンタの進み方を見る
  const steps: unknown[] = [];
  for (let i = 0; i < 7; i += 1) {
    const kind = i % 3;
    const c = kind === 1 ? ctxA : kind === 2 ? ctxB : ctx;
    const counting = kind === 0 ? undefined : "subject";
    const r = await recallAliases(c, ids, counting);
    steps.push([
      kind === 0 ? "tenant" : kind === 1 ? "alice(subject)" : "bob(subject)",
      r.ids,
      await counters(ctx, ["alice", "bob"]),
    ]);
  }
  out["3 recalls advance the clock; the gate drops memories that sank"] = steps;
  out["3b memories after the recalls"] = await seqOf(ctx, ids);

  // 4. usage による強化（起点が今の活動の数に進む。subject あり・なし）
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

  // 5. consolidate・reflect が書く記憶の3つ組
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
  // qA だけが沈んでいる（q0 は T=6 でまだ床 7 を越えていない）。壁時計の軸は生きているので、either は何も選ばない
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

  // 7. 壁時計から活動時計へ切り替える（Issue #1014）
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
      {
        T: 5,
        hasS: true,
        S: {
          alice: 4,
          bob: 2,
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
      m0: ["active", 6, 19, 3],
      mA: ["active", 10, 23, 3],
      mB: ["active", 0, 13, 3],
      q0: ["active", 2, 7, 1],
      qA: ["active", 4, 9, 1],
    },
    {
      T: 6,
      hasS: true,
      S: {
        alice: 4,
        bob: 2,
      },
    },
  ],
  "5 consolidate and reflect write the triple": [
    "consolidated",
    "reflected",
    {
      consolidated: ["active", 10, 15, 1],
      reflected: ["active", 10, 15, 1],
    },
    {
      T: 6,
      hasS: true,
      S: {
        alice: 4,
        bob: 2,
      },
    },
  ],
  "6 sweepArchive clock activity, now=today: only qA has sunk": [
    ["qA"],
    false,
    {
      m0: ["active", 6, 19, 3],
      mA: ["active", 10, 23, 3],
      mB: ["active", 0, 13, 3],
      q0: ["active", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 10, 15, 1],
      reflected: ["active", 10, 15, 1],
    },
  ],
  "6 sweepArchive clock either, now=today: wall axis alive, nothing": [
    [],
    false,
    {
      m0: ["active", 6, 19, 3],
      mA: ["active", 10, 23, 3],
      mB: ["active", 0, 13, 3],
      q0: ["active", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 10, 15, 1],
      reflected: ["active", 10, 15, 1],
    },
  ],
  "6 sweepArchive clock wall, now=today: wall axis alive, nothing": [
    [],
    false,
    {
      m0: ["active", 6, 19, 3],
      mA: ["active", 10, 23, 3],
      mB: ["active", 0, 13, 3],
      q0: ["active", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 10, 15, 1],
      reflected: ["active", 10, 15, 1],
    },
  ],
  "6 sweepArchive clock either, now=FAR: both axes sunk, q0 only": [
    ["q0"],
    false,
    {
      m0: ["active", 6, 19, 3],
      mA: ["active", 10, 23, 3],
      mB: ["active", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 10, 15, 1],
      reflected: ["active", 10, 15, 1],
    },
  ],
  "6b recall after the clock has run far (the gate drops what sank)": [],
  "6 sweepArchive clock wall, now=today: still nothing although the activity axis sank": [
    [],
    false,
    {
      m0: ["active", 6, 19, 3],
      mA: ["active", 10, 23, 3],
      mB: ["active", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["active", 10, 15, 1],
      reflected: ["active", 10, 15, 1],
    },
  ],
  "6 sweepArchive tenant default (activity), now=today: everything that sank": [
    ["consolidated", "m0", "mA", "mB", "reflected"],
    false,
    {
      m0: ["archived", 6, 19, 3],
      mA: ["archived", 10, 23, 3],
      mB: ["archived", 0, 13, 3],
      q0: ["archived", 2, 7, 1],
      qA: ["archived", 4, 9, 1],
      consolidated: ["archived", 10, 15, 1],
      reflected: ["archived", 10, 15, 1],
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
};
const space = TEST_EMBEDDING_SPACE;

afterAll(async () => {
  await closeTestClient();
});

function build(
  base: string,
  stores: {
    mem: MemoryStore;
    vec: PostgresVectorStore | InMemoryVectorStore;
    lex: PostgresLexicalStore | InMemoryLexicalStore;
    ev: PostgresEventStore | InMemoryEventStore;
    ob: PostgresOutboxStore | InMemoryOutboxStore;
    ts: TenantSettingsStore;
    rel: PostgresRelationStore | InMemoryRelationStore;
  },
): Env {
  const runtime: Runtime = createRuntime({
    memoryStore: stores.mem,
    vectorStore: stores.vec,
    lexicalStore: stores.lex,
    outboxStore: stores.ob,
    eventStore: stores.ev,
    relationStore: stores.rel,
    tenantSettingsStore: stores.ts,
    llmProvider: llm,
    embeddingProvider: { space, embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]) },
    hashContent: (content) => `h(${content})`,
  });
  let n = 0;
  return {
    runtime,
    mem: stores.mem,
    ts: stores.ts,
    fresh: () => ({ tenantId: `${base}-${(n += 1)}` }),
    setExtracted: (content) => {
      extractedContent = content;
    },
  };
}

describe("活動時計（decay_clock = activity）の経路（InMemory・Postgres）", () => {
  it("InMemory は Postgres で実測した結果（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    const env = build("activity-clock-inmem", {
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
    });
    expect(await scenario(env)).toEqual(EXPECTED);
  });

  it("Postgres は EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const env = build("activity-clock-pg", {
      mem: new PostgresMemoryStore(db),
      vec: new PostgresVectorStore(db),
      lex: new PostgresLexicalStore(db),
      ev: new PostgresEventStore(db),
      ob: new PostgresOutboxStore(db),
      ts: new PostgresTenantSettingsStore(db),
      rel: new PostgresRelationStore(db),
    });
    expect(await scenario(env)).toEqual(EXPECTED);
  });
});
