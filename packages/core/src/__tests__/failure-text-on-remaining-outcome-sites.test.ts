import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const PARAM_VALUE = "利用者の本文-params-に付いた値";

function drizzleWrapped(reason: string, code: string): Error {
  const pgError = Object.assign(new Error(reason), { code });
  return new Error(`Failed query: UPDATE memories SET status = $1\nparams: ${PARAM_VALUE}`, {
    cause: pgError,
  });
}

function withReason(message: string, reason: string, code: string): Error {
  return new Error(message, { cause: Object.assign(new Error(reason), { code }) });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  return {
    tenantId: "tenant-1",
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
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
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

const consolidatingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({ content: "統合後" }) as T,
};

function buildRuntime(
  llmProvider: LLMProvider,
  wrapMemoryStore?: (memoryStore: MemoryStore) => MemoryStore,
  now = NOW,
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore:
      wrapMemoryStore === undefined ? stores.memoryStore : wrapMemoryStore(stores.memoryStore),
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => now },
  });
  return { runtime, stores };
}

describe("tick: 埋め込みの失敗と failed の書き込みの失敗の両方が、cause の理由と SQLSTATE つきで lastError に載る", () => {
  it("埋め込みの失敗の理由と SQLSTATE が、本文と cause の2か所に載る", async () => {
    const later = new Date(Date.now() + 60_000);
    const { runtime, stores } = buildRuntime(notUsedLlm, undefined, later);
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory({ recordedAt: later }), [
      "embed",
    ]);
    stores.embeddingProvider.embed = async () => {
      throw withReason("embedding provider down", "upstream reset", "ECONNRESET");
    };
    stores.memoryStore.setEmbeddingStatus = async () => {
      throw new Error("marking failed down");
    };

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const lastError = stores.outboxStore.listJobs(ctx)[0]?.lastError ?? "";
    expect(countOccurrences(lastError, "upstream reset (code: ECONNRESET)")).toBe(2);
  });

  it("failed の書き込みの失敗の理由と SQLSTATE が、本文に載る", async () => {
    const later = new Date(Date.now() + 60_000);
    const { runtime, stores } = buildRuntime(notUsedLlm, undefined, later);
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory({ recordedAt: later }), [
      "embed",
    ]);
    stores.embeddingProvider.embed = async () => {
      throw new Error("embedding provider down");
    };
    stores.memoryStore.setEmbeddingStatus = async () => {
      throw withReason("marking failed down", "connection terminated", "08006");
    };

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const lastError = stores.outboxStore.listJobs(ctx)[0]?.lastError ?? "";
    expect(countOccurrences(lastError, "connection terminated (code: 08006)")).toBe(1);
  });
});

describe("consolidate: 統合元ごとの failed の error は、params を落とし cause の理由と SQLSTATE を載せる", () => {
  it("2件目の更新が drizzle が包んだ形で失敗したとき、その1件の error に params が無く cause がある", async () => {
    let updateCalls = 0;
    const { runtime, stores } = buildRuntime(consolidatingLlm, (base) => {
      (base as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories = undefined;
      return new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "updateStatusWithEvent") {
            return async (...args: Parameters<MemoryStore["updateStatusWithEvent"]>) => {
              updateCalls += 1;
              if (updateCalls === 2) {
                throw drizzleWrapped("permission denied for table memories", "42501");
              }
              return target.updateStatusWithEvent(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as MemoryStore;
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ content: "C" }));
    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, c.id] },
    });

    const failed = result.sources.find((s) => s.memoryId === b.id);
    expect(failed).toEqual({
      memoryId: b.id,
      kind: "failed",
      error:
        "Failed query: UPDATE memories SET status = $1\n" +
        `params: (omitted by mnemora, ${PARAM_VALUE.length} chars)` +
        " <- caused by: permission denied for table memories (code: 42501)",
    });
    expect(JSON.stringify(result)).not.toContain(PARAM_VALUE);
  });
});

describe("purge: already_purged の residueCleanup.error は、params を落とし cause の理由と SQLSTATE を載せる", () => {
  it("scrubPurged が drizzle が包んだ形で失敗したとき、error に params が無く cause がある", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const memory: Memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    await runtime.purge(ctx, { memoryId: memory.id });
    Object.defineProperty(stores.memoryStore, "scrubPurged", {
      value: async () => {
        throw drizzleWrapped("permission denied for table memories", "42501");
      },
      configurable: true,
    });

    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(second.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        residueCleanup: {
          status: "failed",
          error:
            "Failed query: UPDATE memories SET status = $1\n" +
            `params: (omitted by mnemora, ${PARAM_VALUE.length} chars)` +
            " <- caused by: permission denied for table memories (code: 42501)",
        },
      },
    ]);
    expect(JSON.stringify(second)).not.toContain(PARAM_VALUE);
  });
});
