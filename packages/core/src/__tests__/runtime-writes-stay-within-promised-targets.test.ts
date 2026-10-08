import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 書き込み側の口が、約束した相手の外（置き換えた記憶・材料の記憶・復帰しなかった記憶）まで書かないこと。
// 足りない側（書くべきものを書かない）の試験は各口のファイルにある。ここはやりすぎた側だけを置く。

const ctx: Ctx = { tenantId: "tenant-writes-stay-within-promised-targets" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
// 作成時刻を NOW より前に置く。reinforce は起点より新しい at だけを書くので、同じ時刻だと書き込みが見えない。
const RECORDED_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? RECORDED_AT;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
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

/** 抽出の LLM。`contents` を記憶の候補として返す。 */
function llmExtracting(contents: string[]): LLMProvider {
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) =>
      req.schema.parse({
        memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
      }),
  };
}

/** 統合・内省の LLM。`result` をそのまま返す（内省なら `outcome: "reflected"` を含める）。 */
function llmReturning(result: Record<string, unknown>): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(result) as T,
  };
}

function buildRuntime(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  llmProvider: LLMProvider = notUsedLlm,
  extractorVersion?: string,
) {
  return createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    ...(extractorVersion === undefined ? {} : { config: { extractorVersion } }),
  });
}

/** 強化で動く欄だけを抜き出す（書かれていないことを見る）。 */
function decayFieldsOf(stores: ReturnType<typeof createFakeRuntimeStores>, id: MemoryId) {
  const row = stores.memoryStore.liveRowForTest(ctx, id)!;
  return {
    lastReinforcedAt: row.lastReinforcedAt?.toISOString() ?? null,
    decayFloorAt: row.decayFloorAt?.toISOString() ?? null,
  };
}

describe("reextract は、今の runtime の extractorVersion の記憶だけを置き換える", () => {
  it("別の版で作られた active の記憶は、内容が違っても superseded にしない（新旧2件が active で残る）", async () => {
    const stores = createFakeRuntimeStores();
    const observed = await buildRuntime(stores, llmExtracting(["旧い版の事実"]), "v1").observe(
      ctx,
      { kind: "utterance", text: "発話" },
    );
    const [oldId] = observed.memoryIds as [MemoryId];

    const result = await buildRuntime(stores, llmExtracting(["新しい版の事実"]), "v2").reextract(
      ctx,
      observed.observationId,
    );

    expect(result.supersededMemoryIds).toEqual([]);
    expect(result.memoryIds).toHaveLength(1);
    expect(result.memoryIds[0]).not.toBe(oldId);
    expect((await stores.memoryStore.get(ctx, oldId))?.status).toBe("active");
    expect((await stores.memoryStore.get(ctx, result.memoryIds[0]!))?.status).toBe("active");
    expect(
      stores.eventStore.events.filter((e) => e.memoryId === oldId && e.kind === "superseded"),
    ).toEqual([]);
  });
});

describe("restoreArchived は、復帰に成功した記憶だけを強化する", () => {
  it.each([
    { racedTo: "active" as const, outcome: "status_not_archived" },
    { racedTo: "forgotten" as const, outcome: "conflicted" },
  ])(
    "読んだ後に $racedTo へ動かされて $outcome になった記憶は、reinforce せず強化の欄も動かさない",
    async ({ racedTo, outcome }) => {
      const stores = createFakeRuntimeStores();
      const runtime = buildRuntime(stores);
      const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
      const before = decayFieldsOf(stores, memory.id);
      stores.memoryStore.beforeUpdateStatus = (id) => {
        if (id === memory.id) {
          stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = racedTo;
        }
      };
      const reinforce = vi.spyOn(stores.memoryStore, "reinforce");

      const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

      expect(result.outcomes[0]?.kind).toBe(outcome);
      expect(reinforce).not.toHaveBeenCalled();
      expect(decayFieldsOf(stores, memory.id)).toEqual(before);
    },
  );
});

describe("purge は、既に purge 済みの記憶へ MemoryStore の書き込みを撃たない", () => {
  it.each([{ dryRun: false }, { dryRun: true }])(
    "dryRun: $dryRun の already_purged では purgeMemory を呼ばない",
    async ({ dryRun }) => {
      const stores = createFakeRuntimeStores();
      const runtime = buildRuntime(stores);
      const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
      await runtime.purge(ctx, { memoryId: memory.id });
      const purgeMemory = vi.spyOn(stores.memoryStore, "purgeMemory");

      const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun });

      expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
      expect(purgeMemory).not.toHaveBeenCalled();
    },
  );
});

describe("reflect は足すだけで、材料の記憶には書かない", () => {
  it("reflected になっても、材料の記憶は reinforce されず、強化の欄も status も動かず、イベントも増えない", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = buildRuntime(stores, llmReturning({ outcome: "reflected", content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const beforeA = decayFieldsOf(stores, a.id);
    const beforeB = decayFieldsOf(stores, b.id);
    const reinforce = vi.spyOn(stores.memoryStore, "reinforce");

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("reflected");
    expect(reinforce).not.toHaveBeenCalled();
    expect(decayFieldsOf(stores, a.id)).toEqual(beforeA);
    expect(decayFieldsOf(stores, b.id)).toEqual(beforeB);
    expect((await stores.memoryStore.get(ctx, a.id))?.status).toBe("active");
    expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("active");
    expect(
      stores.eventStore.events.filter((e) => e.memoryId === a.id || e.memoryId === b.id),
    ).toEqual([]);
  });
});

describe("consolidate の superseded イベントは、書き込みの経路によらず content を運ばない", () => {
  it.each([{ storeSupported: true }, { storeSupported: false }])(
    "supersedeWithNewMemories が在る: $storeSupported",
    async ({ storeSupported }) => {
      const stores = createFakeRuntimeStores();
      if (!storeSupported) {
        Object.defineProperty(stores.memoryStore, "supersedeWithNewMemories", {
          value: undefined,
          configurable: true,
        });
      }
      const runtime = buildRuntime(stores, llmReturning({ content: "統合後" }));
      const a = await stores.memoryStore.createMemory(
        ctx,
        newMemory({ content: "A の秘密の本文", digest: "A の要旨" }),
      );
      const b = await stores.memoryStore.createMemory(
        ctx,
        newMemory({ content: "B の秘密の本文", digest: "B の要旨" }),
      );

      const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

      expect(result.atomicity).toBe(storeSupported ? "store_supported" : "store_unsupported");
      for (const source of [a, b]) {
        const events = stores.eventStore.events.filter(
          (e) => e.memoryId === source.id && e.kind === "superseded",
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.meta).toEqual({
          reason: "consolidated",
          supersededById: result.consolidatedMemoryId,
        });
        expect(JSON.stringify(events[0])).not.toContain("秘密の本文");
      }
    },
  );
});
