import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { OutboxStore } from "../interfaces/outbox-store.js";
import type { Memory, NewMemory } from "../memory.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createRuntime, type ContestedResolution, type Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0526: `tick` 経由の `consolidate`・`reflect` ジョブと、訂正の経路で負けた記憶がある状態での `reextract`（Fake）。同じ `EXPECTED` を
 * 実 Postgres と InMemory の側（`packages/postgres/src/__tests__/runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts`）が縛る。
 * 大文字の uuid の id は含めない。
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
 * ADR 0526（ADR 0524 の「測っていないこと」の実測）: (1) `tick` 経由の `consolidate`・`reflect` ジョブ（種・近傍の記憶を消した後、
 * `eraseTenant` の後、LLM の障害）、(2) 訂正の経路（`findCorrectionCandidates`＋`applyCorrection`）で負けて `superseded`（または `contested`）
 * になった記憶がある状態での `reextract` を、平らなデータにする。実装ごとの差が出るのは、操作の対象の id を大文字で渡したときだけで
 * （ADR 0446・0469。ここには含めない）、小文字の id では3者が一致した。core の Fake の歯と、InMemory・Postgres の歯が、同じ `EXPECTED` に突き合わせる。
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
  // (2) 訂正の経路で負けた記憶と reextract
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

let hashCounter = 0;
function newMemory(ctx: Ctx, content: string, over: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `tick-jobs-${hashCounter}`,
    digest: content,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720, // testkit の `buildNewMemoryFixture` と同じ（近傍の判定が半減期に依る）
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...over,
  };
}

describe("tick 経由の consolidate・reflect ジョブと、訂正の経路で負けた記憶がある reextract（Fake）", () => {
  it("Postgres で実測した結果（EXPECTED）と一致する", async () => {
    const stores = createFakeRuntimeStores();
    const space = { provider: "fake", model: "fake-model", dimensions: 3 };
    // 時計は注入しない: 注入した過去の時計では tick がジョブを取らない（`RuntimeDeps.clock` の doc）
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
      config: { autoQueueConsolidateReflectOnExtract: true },
    });
    const toRow = (j: OutboxJobRecord) => ({
      kind: j.kind,
      attempts: j.attempts,
      done: j.completedAt != null,
      failed: j.failedAt != null,
      last_error: j.lastError,
      claimed: j.claimedBy != null,
    });
    const out = await scenario({
      runtime,
      mem: stores.memoryStore as MemoryStore,
      ev: stores.eventStore as EventStore,
      ob: stores.outboxStore as OutboxStore,
      base: "tick-jobs-fake",
      rows: async (ctx) => stores.outboxStore.listJobs(ctx).map(toRow),
      mk: async (ctx, content) => {
        const m = await stores.memoryStore.createMemory(ctx, newMemory(ctx, content));
        await stores.vectorStore.upsert(ctx, space, m.id, [1, 0, 0]);
        return m;
      },
      enqueue: async (ctx, kind) => {
        const { memory } = await stores.memoryStore.createMemoryWithOutbox(
          ctx,
          newMemory(ctx, "banana seed"),
          [kind],
        );
        await stores.vectorStore.upsert(ctx, space, memory.id, [1, 0, 0]);
        return memory;
      },
      embed: async (ctx, m) => {
        await stores.vectorStore.upsert(ctx, space, m.id, [1, 0, 0]);
        await stores.memoryStore.setEmbeddingStatus(ctx, m.id, "ready");
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
      setLlmThrows: (on) => {
        llmThrows = on;
      },
    });
    expect(out).toEqual(EXPECTED);
  });
});
