import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.markContestedGroup`（Issue #207/#933 PR2、ADR 0327 §4-c、ADR 0378、ADR 0381）の歯。
 *
 * 設計の要点（`runtime.ts` の `MarkContestedGroupOutcome`/`markContestedGroup` の
 * doc コメント参照。`mark-contested.test.ts`（2者版）と対称に書いてある）:
 * - `memberIds.length < 3` は書き込み前に `RangeError`。
 * - `memberIds` の重複も書き込み前に `RangeError`。
 * - 各メンバーが呼び出し時点で `active`／穴Aの相方吸収／既存群の合併吸収のいずれかで
 *   なければ、書き込みを一切試みず `ineligible` を返す。
 * - `MemoryStore.markContestedGroup` が無い adapter では `supported: false`。
 * - 成功すれば全員 `status: 'contested'`・`contestedWithId: null` になり、有効期間が
 *   重なる組にだけ `memory_relations` が張られる。
 */

const ctx: Ctx = { tenantId: "tenant-mcg" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-mcg",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function disableMarkContestedGroup(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "markContestedGroup", {
    value: undefined,
    configurable: true,
  });
}

describe("runtime.markContestedGroup — 基本の成功（3件、新規）", () => {
  it("全員 active な3件は全員 contested になり、memory_relations が全組に張られる", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));

    const result = await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    expect(result.supported).toBe(true);
    expect(result.outcome.kind).toBe("contested_group");
    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    const storedC = await stores.memoryStore.get(ctx, c.id);
    expect(storedA?.status).toBe("contested");
    expect(storedB?.status).toBe("contested");
    expect(storedC?.status).toBe("contested");
    // 群のメンバーは contestedWithId を持たない設計（ADR 0378 決定1 §3.3）。
    expect(storedA?.contestedWithId ?? null).toBe(null);

    const related = await stores.relationStore.listRelated(ctx, a.id, "contradicts");
    expect(related.map((r) => r.memoryId).sort()).toEqual([b.id, c.id].sort());
  });

  it("全員に kind='updated', meta.reason='contested' のイベントが1件ずつ積まれ、meta.contestedWithId は無い", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));

    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    for (const id of [a.id, b.id, c.id]) {
      const events = stores.eventStore.events.filter((e) => e.memoryId === id);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("updated");
      expect(events[0]?.meta).toEqual({ reason: "contested" });
    }
  });

  it("reason を渡すと meta.note に入る", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));

    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id], { reason: "根拠のJSON" });

    const [eventA] = stores.eventStore.events.filter((e) => e.memoryId === a.id);
    expect(eventA?.meta).toEqual({ reason: "contested", note: "根拠のJSON" });
  });
});

describe("runtime.markContestedGroup — memberIds の検査（呼び手のバグ）", () => {
  it("2件以下は書き込み前に RangeError", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    await expect(runtime.markContestedGroup!(ctx, [a.id, b.id])).rejects.toThrow(RangeError);
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("重複した id は書き込み前に RangeError", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    await expect(runtime.markContestedGroup!(ctx, [a.id, b.id, a.id])).rejects.toThrow(RangeError);
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.markContestedGroup — ineligible", () => {
  it("1件でも存在しない id があれば、書き込みを一切試みず not_found を積む", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const result = await runtime.markContestedGroup!(ctx, [a.id, b.id, "does-not-exist"]);

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "eligible" },
          { memoryId: b.id, kind: "eligible" },
          { memoryId: "does-not-exist", kind: "not_found" },
        ],
      },
    });
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("1件が superseded など吸収条件を満たさない status だと status_conflict になり、何も書かない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "C", status: "superseded" }),
    );

    const result = await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    expect(result.outcome).toEqual({
      kind: "ineligible",
      sides: [
        { memoryId: a.id, kind: "eligible" },
        { memoryId: b.id, kind: "eligible" },
        { memoryId: c.id, kind: "status_conflict", status: "superseded", contestedWithId: null },
      ],
    });
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("穴A: contested かつ contestedWithId が渡された memberIds の他の誰かなら eligible（吸収）", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    // a・b を先に2者間の対にする。
    await runtime.markContested(ctx, a.id, b.id);

    const result = await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    expect(result.outcome.kind).toBe("contested_group");
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("contested");
    expect(storedA?.contestedWithId ?? null).toBe(null);
  });

  it("穴A: contested かつ contestedWithId が memberIds の外を指すなら status_conflict（相方を含めずに片方だけ渡した場合）", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    const d = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "D" }));
    await runtime.markContested(ctx, a.id, b.id);

    // b（a と対）を、a を含めずに c・d と一緒に渡す——b の contestedWithId(a) が
    // memberIds の外を指すので status_conflict になる。
    const result = await runtime.markContestedGroup!(ctx, [b.id, c.id, d.id]);

    expect(result.outcome).toEqual({
      kind: "ineligible",
      sides: [
        {
          memoryId: b.id,
          kind: "status_conflict",
          status: "contested",
          contestedWithId: a.id,
        },
        { memoryId: c.id, kind: "eligible" },
        { memoryId: d.id, kind: "eligible" },
      ],
    });
  });
});

describe("runtime.markContestedGroup — MemoryStore.markContestedGroup が無い adapter（任意メソッド、フォールバック無し）", () => {
  it("markContestedGroup が無ければ supported: false・not_attempted・書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    disableMarkContestedGroup(stores);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));

    const result = await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    expect(result).toEqual({ supported: false, outcome: { kind: "not_attempted" } });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.markContestedGroup — 並行（markContestedGroup が MemoryStatusConflictError を投げる）", () => {
  it("読んだ後・書く前に1件の status が変わっていた⟹ conflict を返し、全員の現在値を1回だけ再読する", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === c.id) {
        // ADR 0562: `createMemory` の返り値は写し。store の中の行を書き換える。
        stores.memoryStore.liveRowForTest(ctx, c.id)!.status = "archived";
      }
    };

    const result = await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "conflict",
        conflicts: [
          { id: a.id, observedStatus: "active" },
          { id: b.id, observedStatus: "active" },
          { id: c.id, observedStatus: "archived" },
        ],
      },
    });
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.markContestedGroup — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも active な Memory は contested にならない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const stored = await stores.memoryStore.get(ctx, a.id);
    expect(stored?.status).toBe("active");
  });
});
