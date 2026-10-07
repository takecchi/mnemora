import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import {
  FOREIGN_VARIANTS,
  foreignMemoryStatusConflict,
  foreignOutboxLeaseConflict,
} from "./foreign-realm-errors.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** store に別の realm の例外（`vm` で定義し直したクラス）を投げさせて、runtime がそれを本物と同じに扱うことを検査する。 */

const ctx: Ctx = { tenantId: "tenant-1" };

function llmReturning(memories: { content: string; digest: string }[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({
        memories: memories.map((m) => ({ ...m, provenanceKind: "stated" })),
      }) as T,
  };
}

function buildRuntime(llmProvider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

describe.each(FOREIGN_VARIANTS)("別の realm の store 例外 — $label", (variant) => {
  it("陽性対照: 別の realm の例外は、本物のクラスの instanceof では false になる", () => {
    const lease = foreignOutboxLeaseConflict("j", 1, 2, variant);
    const status = foreignMemoryStatusConflict("m", "archived", "active", variant);
    expect(lease instanceof OutboxLeaseConflictError).toBe(false);
    expect(status instanceof MemoryStatusConflictError).toBe(false);
  });

  it("⭐ (a)(b) tick: complete がリース競合（別の realm の例外）でも tick は reject されず、leaseConflicts に積まれ、後続のジョブは処理される", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([{ content: "本文", digest: "要旨" }]));
    const observeA = await runtime.observe(ctx, { kind: "utterance", text: "本文A" });
    const observeB = await runtime.observe(ctx, { kind: "utterance", text: "本文B" });
    const memoryIdA = observeA.memoryIds[0]!;
    const memoryIdB = observeB.memoryIds[0]!;

    let conflictJobId: string | null = null;
    const originalComplete = stores.outboxStore.complete.bind(stores.outboxStore);
    const originalFail = stores.outboxStore.fail.bind(stores.outboxStore);
    stores.outboxStore.complete = async (c, jobId, expected, opts) => {
      conflictJobId ??= jobId;
      if (jobId === conflictJobId) {
        throw foreignOutboxLeaseConflict(jobId, expected, expected + 1, variant);
      }
      return originalComplete(c, jobId, expected, opts);
    };
    stores.outboxStore.fail = async (c, jobId, error, expected, opts) => {
      if (jobId === conflictJobId) {
        throw foreignOutboxLeaseConflict(jobId, expected, expected + 1, variant);
      }
      return originalFail(c, jobId, error, expected, opts);
    };

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], limit: 10, leaseMs: 60_000 });

    expect(tickResult.processed).toBe(1);
    expect(tickResult.failed).toBe(0);
    expect(tickResult.leaseConflicts).toHaveLength(1);
    expect(tickResult.leaseConflicts[0]).toMatchObject({
      jobId: conflictJobId,
      kind: "embed",
      attemptedOutcome: "complete",
    });
    const embedded = [
      (await stores.memoryStore.get(ctx, memoryIdA))?.embeddingStatus,
      (await stores.memoryStore.get(ctx, memoryIdB))?.embeddingStatus,
    ];
    expect(embedded.filter((s) => s === "ready")).toHaveLength(2);
  });

  it("⭐ (c) restoreArchived: updateStatusWithEvent が別の realm の MemoryStatusConflictError を投げても status_not_archived になる", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const recordedAt = new Date("2026-05-31T00:00:00.000Z");
    const newMemory: NewMemory = {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-1",
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
      status: "archived",
    };
    const memory = await stores.memoryStore.createMemory(ctx, newMemory);
    stores.memoryStore.updateStatusWithEvent = async (_c, id, expected) => {
      // `createMemory` の返り値は写しなので、store の中の行を書き換える。
      stores.memoryStore.liveRowForTest(ctx, memory.id)!.status = "active";
      throw foreignMemoryStatusConflict(id, expected, "active", variant);
    };

    const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "status_not_archived", status: "active" },
    ]);
  });
});
