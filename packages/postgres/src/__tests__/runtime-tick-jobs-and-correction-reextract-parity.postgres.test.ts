import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  ContestedResolution,
  Ctx,
  EventStore,
  Memory,
  MemoryStore,
  NewMemoryEvent,
  OutboxStore,
  Runtime,
  StructuredRequest,
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
 * `tick` 経由の `consolidate`・`reflect` ジョブと、訂正の経路で負けた記憶がある状態での `reextract` を、実 Postgres と InMemory の両方で `EXPECTED` に突き合わせる。
 * core の Fake の側は `packages/core/src/__tests__/fake-runtime-tick-jobs-and-correction-reextract-parity.test.ts` が同じ `EXPECTED` を縛る。大文字の uuid の id は含めない。
 */
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  ev: EventStore;
  ob: OutboxStore;
  /** その tenant の outbox の行（kind・attempts・完了・失敗・lastError）。 */
  rows: (ctx: Ctx) => Promise<Array<Record<string, unknown>>>;
  /** 記憶を作り、ベクトルも入れる（`embeddingStatus: "ready"`）。 */
  mk: (ctx: Ctx, content: string) => Promise<Memory>;
  /** 記憶を作り、`kind` のジョブ（payload は `{ memoryId }`）を1本積む。ベクトルも入れる。 */
  enqueue: (ctx: Ctx, kind: "consolidate" | "reflect") => Promise<Memory>;
  /** 既に在る記憶にベクトルを入れ、`embeddingStatus` を `ready` にする。 */
  embed: (ctx: Ctx, m: Memory) => Promise<void>;
  /** `utterance` の observation を作る。 */
  obs: (ctx: Ctx, externalId: string) => Promise<{ id: string }>;
  /** 決め打ちの LLM の応答（抽出の `memories` を差し替える）。 */
  setExtracted: (content: string) => void;
  /** `true` の間、LLM は例外を投げる（実 API の障害の代わり）。 */
  setLlmThrows: (on: boolean) => void;
  base: string;
}

type Result = Record<string, unknown>;

/**
 * (1) `tick` 経由の `consolidate`・`reflect` ジョブ（種・近傍の記憶を消した後、`eraseTenant` の後、LLM の障害）、
 * (2) 訂正の経路（`findCorrectionCandidates`＋`applyCorrection`）で負けて `superseded`（または `contested`）になった記憶がある状態での `reextract` を、平らなデータにする。
 * core の Fake の歯と、InMemory・Postgres の歯が、同じ `EXPECTED` に突き合わせる。
 */
async function scenario(env: Env): Promise<Result> {
  const { runtime, mem, ev, ob, rows, mk, enqueue, obs, setExtracted, setLlmThrows } = env;
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
  const tick = async (ctx: Ctx, kind: "consolidate" | "reflect", leaseMs = 1000) => {
    const t = await runtime.tick(ctx, { leaseMs, kinds: [kind] });
    return [t.processed, t.failed, t.unsupported.length];
  };
  const outbox = async (ctx: Ctx) =>
    (await rows(ctx)).sort((a, b) => String(a["kind"]).localeCompare(String(b["kind"])));
  const STATES = ["active", "forgotten", "archived", "superseded", "purged"];
  for (const kind of ["consolidate", "reflect"] as const) {
    for (const st of STATES) {
      let ctx = fresh();
      let seed = await enqueue(ctx, kind);
      let nb = await mk(ctx, "banana neighbor");
      await toState(ctx, seed, st);
      out[`tick ${kind}: seed ${st}`] = [
        await tick(ctx, kind),
        await outbox(ctx),
        await snap(ctx, [seed, nb]),
      ];
      ctx = fresh();
      seed = await enqueue(ctx, kind);
      nb = await mk(ctx, "banana neighbor");
      await toState(ctx, nb, st);
      out[`tick ${kind}: seed active, neighbor ${st}`] = [
        await tick(ctx, kind),
        await outbox(ctx),
        await snap(ctx, [seed, nb]),
      ];
    }
    let ctx = fresh();
    const seed = await enqueue(ctx, kind);
    await mem.eraseTenant!(ctx, { limit: 1000 });
    out[`tick ${kind}: after MemoryStore.eraseTenant (job row remains)`] = [
      await tick(ctx, kind),
      await outbox(ctx),
      (await mem.get(ctx, seed.id)) === null,
    ];
    ctx = fresh();
    await enqueue(ctx, kind);
    await ob.eraseTenant!(ctx, { limit: 1000 });
    out[`tick ${kind}: after OutboxStore.eraseTenant`] = [await tick(ctx, kind), await outbox(ctx)];
    ctx = fresh();
    await enqueue(ctx, kind);
    await mk(ctx, "banana neighbor");
    await tick(ctx, kind);
    out[`tick ${kind}: second tick after the job finished`] = [
      await tick(ctx, kind),
      await outbox(ctx),
    ];
    ctx = fresh();
    await enqueue(ctx, kind);
    await mk(ctx, "banana neighbor");
    setLlmThrows(true);
    try {
      out[`tick ${kind}: LLM outage (two ticks)`] = [
        await tick(ctx, kind),
        await tick(ctx, kind),
        await outbox(ctx),
      ];
    } finally {
      setLlmThrows(false);
    }
  }
  const VARIANTS: Array<[string, (c: Memory, m: Memory) => ContestedResolution | undefined]> = [
    ["resolution supersede, winner=correcting", (c) => ({ kind: "supersede", winnerId: c.id })],
    ["resolution supersede, winner=corrected", (_c, m) => ({ kind: "supersede", winnerId: m.id })],
    ["resolution both_active", () => ({ kind: "both_active" })],
    ["no resolution (contested pending)", () => undefined],
  ];
  for (const [vn, resolution] of VARIANTS) {
    for (const second of ["extracted fact", "different fact"]) {
      const ctx = fresh();
      const o = await obs(ctx, "ext-1");
      setExtracted("extracted fact");
      const first = await runtime.reextract(ctx, o.id);
      const corrected = (await mem.get(ctx, first.memoryIds[0]!))!;
      await env.embed(ctx, corrected);
      const correcting = await mk(ctx, "extracted fact corrected");
      const discovery = await runtime.findCorrectionCandidates(ctx, {
        text: "extracted fact",
        excludeMemoryIds: [correcting.id],
        limit: 100,
      });
      const res = resolution(correcting, corrected);
      const ac = await runtime.applyCorrection(ctx, {
        discovery,
        correctedId: corrected.id,
        correctingId: correcting.id,
        ...(res ? { resolution: res } : {}),
      });
      const before = await snap(ctx, [corrected, correcting]);
      setExtracted(second);
      const x = await runtime.reextract(ctx, o.id);
      setExtracted("extracted fact");
      out[`reextract after correction [${vn}] second=${second}`] = [
        ac.kind,
        before.status,
        [
          x.memoryIds.length,
          x.supersededMemoryIds.length,
          x.skipped.map((s) => [s.kind, "status" in s ? s.status : null]),
          x.extraction,
          x.atomicity,
        ],
        await snap(ctx, [corrected, correcting]),
      ];
    }
  }
  // 負けた記憶の「理由」を読むイベントが保持期間の掃除で消えると、その superseded は退けたものと数えられず、抽出がやり直される（TSDoc の約束）
  {
    const ctx = fresh();
    const o = await obs(ctx, "ext-purged-events");
    setExtracted("extracted fact");
    const first = await runtime.reextract(ctx, o.id);
    const corrected = (await mem.get(ctx, first.memoryIds[0]!))!;
    await env.embed(ctx, corrected);
    const correcting = await mk(ctx, "extracted fact corrected");
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: "extracted fact",
      excludeMemoryIds: [correcting.id],
      limit: 100,
    });
    await runtime.applyCorrection(ctx, {
      discovery,
      correctedId: corrected.id,
      correctingId: correcting.id,
      resolution: { kind: "supersede", winnerId: correcting.id },
    });
    const purged = await mem.purgeExpiredEvents!(ctx, {
      olderThan: new Date("2099-01-01T00:00:00.000Z"),
      limit: 1000,
    });
    setExtracted("different fact");
    const x = await runtime.reextract(ctx, o.id);
    setExtracted("extracted fact");
    out["reextract after correction, then purgeExpiredEvents"] = [
      purged.purged > 0,
      [x.memoryIds.length, x.supersededMemoryIds.length, x.skipped.map((s) => s.kind)],
      await snap(ctx, [corrected, correcting]),
    ];
  }
  return out;
}

let extractedContent = "extracted fact";
let llmThrows = false;
const llm = {
  name: "canned",
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    if (llmThrows) throw new Error("simulated LLM outage");
    return req.schema.parse({
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
    }) as T;
  },
};

const EXPECTED: Result = {
  "tick consolidate: seed active": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "active"],
      events: [],
    },
  ],
  "tick consolidate: seed active, neighbor active": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "active"],
      events: [],
    },
  ],
  "tick consolidate: seed forgotten": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["forgotten", "active"],
      events: [],
    },
  ],
  "tick consolidate: seed active, neighbor forgotten": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "forgotten"],
      events: [],
    },
  ],
  "tick consolidate: seed archived": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["archived", "active"],
      events: [],
    },
  ],
  "tick consolidate: seed active, neighbor archived": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "archived"],
      events: [],
    },
  ],
  "tick consolidate: seed superseded": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["superseded", "active"],
      events: [],
    },
  ],
  "tick consolidate: seed active, neighbor superseded": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "superseded"],
      events: [],
    },
  ],
  "tick consolidate: seed purged": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["forgotten", "active"],
      events: ["purged"],
    },
  ],
  "tick consolidate: seed active, neighbor purged": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "forgotten"],
      events: ["purged"],
    },
  ],
  "tick consolidate: after MemoryStore.eraseTenant (job row remains)": [
    [1, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    true,
  ],
  "tick consolidate: after OutboxStore.eraseTenant": [[0, 0, 0], []],
  "tick consolidate: second tick after the job finished": [
    [0, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
  ],
  "tick consolidate: LLM outage (two ticks)": [
    [1, 0, 0],
    [0, 0, 0],
    [
      {
        kind: "consolidate",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
  ],
  "tick reflect: seed active": [
    [1, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "active"],
      events: ["created"],
    },
  ],
  "tick reflect: seed active, neighbor active": [
    [1, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "active"],
      events: ["created"],
    },
  ],
  "tick reflect: seed forgotten": [
    [1, 0, 0],
    [
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["forgotten", "active"],
      events: [],
    },
  ],
  "tick reflect: seed active, neighbor forgotten": [
    [1, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "forgotten"],
      events: ["created"],
    },
  ],
  "tick reflect: seed archived": [
    [1, 0, 0],
    [
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["archived", "active"],
      events: [],
    },
  ],
  "tick reflect: seed active, neighbor archived": [
    [1, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "archived"],
      events: ["created"],
    },
  ],
  "tick reflect: seed superseded": [
    [1, 0, 0],
    [
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["superseded", "active"],
      events: [],
    },
  ],
  "tick reflect: seed active, neighbor superseded": [
    [1, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "superseded"],
      events: ["created"],
    },
  ],
  "tick reflect: seed purged": [
    [1, 0, 0],
    [
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["forgotten", "active"],
      events: ["purged"],
    },
  ],
  "tick reflect: seed active, neighbor purged": [
    [1, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    {
      status: ["active", "forgotten"],
      events: ["created", "purged"],
    },
  ],
  "tick reflect: after MemoryStore.eraseTenant (job row remains)": [
    [1, 0, 0],
    [
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
    true,
  ],
  "tick reflect: after OutboxStore.eraseTenant": [[0, 0, 0], []],
  "tick reflect: second tick after the job finished": [
    [0, 0, 0],
    [
      {
        kind: "embed",
        attempts: 0,
        done: false,
        failed: false,
        last_error: null,
        claimed: false,
      },
      {
        kind: "reflect",
        attempts: 1,
        done: true,
        failed: false,
        last_error: null,
        claimed: true,
      },
    ],
  ],
  "tick reflect: LLM outage (two ticks)": [
    [0, 1, 0],
    [0, 0, 0],
    [
      {
        kind: "reflect",
        attempts: 1,
        done: false,
        failed: true,
        last_error:
          "runtime.tick: reflect job failed because the llm call failed: simulated LLM outage",
        claimed: true,
      },
    ],
  ],
  "reextract after correction [resolution supersede, winner=correcting] second=extracted fact": [
    "resolved",
    ["superseded", "active"],
    [0, 0, [["status_not_active", "superseded"]], "skipped", "not_attempted"],
    {
      status: ["superseded", "active"],
      events: ["created", "superseded", "updated", "updated", "updated"],
    },
  ],
  "reextract after correction [resolution supersede, winner=correcting] second=different fact": [
    "resolved",
    ["superseded", "active"],
    [0, 0, [["status_not_active", "superseded"]], "skipped", "not_attempted"],
    {
      status: ["superseded", "active"],
      events: ["created", "superseded", "updated", "updated", "updated"],
    },
  ],
  "reextract after correction [resolution supersede, winner=corrected] second=extracted fact": [
    "resolved",
    ["active", "superseded"],
    [1, 0, [["unchanged", null]], "ok", "store_supported"],
    {
      status: ["active", "superseded"],
      events: ["created", "superseded", "updated", "updated", "updated"],
    },
  ],
  "reextract after correction [resolution supersede, winner=corrected] second=different fact": [
    "resolved",
    ["active", "superseded"],
    [1, 1, [], "ok", "store_supported"],
    {
      status: ["superseded", "superseded"],
      events: ["created", "created", "superseded", "superseded", "updated", "updated", "updated"],
    },
  ],
  "reextract after correction [resolution both_active] second=extracted fact": [
    "resolved",
    ["active", "active"],
    [1, 0, [["unchanged", null]], "ok", "store_supported"],
    {
      status: ["active", "active"],
      events: ["created", "updated", "updated", "updated", "updated"],
    },
  ],
  "reextract after correction [resolution both_active] second=different fact": [
    "resolved",
    ["active", "active"],
    [1, 1, [], "ok", "store_supported"],
    {
      status: ["superseded", "active"],
      events: ["created", "created", "superseded", "updated", "updated", "updated", "updated"],
    },
  ],
  "reextract after correction [no resolution (contested pending)] second=extracted fact": [
    "contested",
    ["contested", "contested"],
    [0, 0, [["status_not_active", "contested"]], "skipped", "not_attempted"],
    {
      status: ["contested", "contested"],
      events: ["created", "updated", "updated"],
    },
  ],
  "reextract after correction [no resolution (contested pending)] second=different fact": [
    "contested",
    ["contested", "contested"],
    [0, 0, [["status_not_active", "contested"]], "skipped", "not_attempted"],
    {
      status: ["contested", "contested"],
      events: ["created", "updated", "updated"],
    },
  ],
  "reextract after correction, then purgeExpiredEvents": [
    true,
    [1, 0, ["status_not_active"]],
    {
      status: ["superseded", "active"],
      events: ["created", "events_purged"],
    },
  ],
};
const space = TEST_EMBEDDING_SPACE;

afterAll(async () => {
  await closeTestClient();
});

let hashCounter = 0;
function fixture(ctx: Ctx, content: string) {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `tick-jobs-${hashCounter}`,
    content,
    digest: content,
    embeddingStatus: "ready",
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

function build(base: string, stores: Stores, rows: Env["rows"]): Env {
  // 時計は注入しない: 注入した過去の時計では tick がジョブを取らない（`RuntimeDeps.clock` の doc）
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
    config: { autoQueueConsolidateReflectOnExtract: true },
  });
  return {
    runtime,
    mem: stores.mem,
    ev: stores.ev,
    ob: stores.ob,
    rows,
    base,
    mk: async (ctx, content) => {
      const m = await stores.mem.createMemory(ctx, fixture(ctx, content));
      await stores.vec.upsert(ctx, space, m.id, [1, 0, 0]);
      return m;
    },
    enqueue: async (ctx, kind) => {
      const { memory } = await stores.mem.createMemoryWithOutbox(ctx, fixture(ctx, "banana seed"), [
        kind,
      ]);
      await stores.vec.upsert(ctx, space, memory.id, [1, 0, 0]);
      return memory;
    },
    embed: async (ctx, m) => {
      await stores.vec.upsert(ctx, space, m.id, [1, 0, 0]);
      await stores.mem.setEmbeddingStatus(ctx, m.id, "ready");
    },
    obs: (ctx, externalId) =>
      stores.mem.createObservation(ctx, {
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
    setLlmThrows: (on) => {
      llmThrows = on;
    },
  };
}

describe("tick 経由の consolidate・reflect ジョブと、訂正の経路で負けた記憶がある reextract（InMemory・Postgres）", () => {
  it("InMemory の、tick 経由の consolidate・reflect ジョブと、訂正の経路（findCorrectionCandidates・applyCorrection）で負けた記憶がある reextract の結果が、Postgres で実測した値（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    const env = build(
      "tick-jobs-inmem",
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
    );
    expect(await scenario(env)).toEqual(EXPECTED);
  });

  it("Postgres の、tick 経由の consolidate・reflect ジョブと、訂正の経路（findCorrectionCandidates・applyCorrection）で負けた記憶がある reextract の結果が、EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const env = build(
      "tick-jobs-pg",
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
    );
    expect(await scenario(env)).toEqual(EXPECTED);
  });
});
