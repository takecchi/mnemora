import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `processEmbedJob` は `vectorStore.upsert` に成功したあとで `setEmbeddingStatus(…, "ready")` が
 * 一時的に失敗すると、`catch` が `failed` を書いて投げ直す。この歯は、その結果の姿を実測で固定する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const LATER = new Date(Date.now() + 60_000);

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(): NewMemory {
  const recordedAt = LATER;
  return {
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
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

describe("processEmbedJob — upsert 成功後の ready の書き込みが一時的に失敗したとき", () => {
  it("記憶は failed・ベクトルは在る・ジョブは終端。次の tick では回復しない。reembed + tick で ready に戻る", async () => {
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
      clock: { now: () => LATER },
    });
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), [
      "embed",
    ]);

    // `setEmbeddingStatus` の最初の1回だけ失敗する（= "ready" の書き込み）。
    const statusWrites: string[] = [];
    const original = stores.memoryStore.setEmbeddingStatus.bind(stores.memoryStore);
    stores.memoryStore.setEmbeddingStatus = async (c, id, status) => {
      statusWrites.push(status);
      if (statusWrites.length === 1) {
        throw new Error("transient: connection reset while marking ready");
      }
      return original(c, id, status);
    };
    const space = stores.embeddingProvider.space;

    const first = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(first).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });
    expect(statusWrites).toEqual(["ready", "failed"]);
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("failed");
    // ベクトルは書けている（upsert は成功していた）。
    expect(await stores.vectorStore.getVectors(ctx, space, [memory.id])).toHaveLength(1);
    // ジョブは終端（failedAt）で、`lastError` に元の失敗が載る。自動リトライには戻らない。
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.failedAt).not.toBeNull();
    expect(job?.lastError).toContain("connection reset while marking ready");

    // 次の tick では何も起きない（ジョブは claim の対象から外れている）。
    const second = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(second).toEqual({ processed: 0, failed: 0, unsupported: [], leaseConflicts: [] });
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("failed");

    // 回復の道: reembed で積み直して tick すれば ready に戻る（failed → ready は許される）。
    const requeued = await runtime.reembed(ctx, { statuses: ["failed"], limit: 10 });
    expect(requeued.requeued).toBe(1);
    const third = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(third.processed).toBe(1);
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("ready");
  });
});

describe("processEmbedJob の注釈 — この性質を書いてある", () => {
  it("ready の書き込みの失敗が failed になる・ジョブは終端・reembed で戻る、を名指ししている", () => {
    const source = readFileSync(fileURLToPath(new URL("../runtime.ts", import.meta.url)), "utf8");
    const start = source.indexOf("async function processEmbedJob(");
    const end = source.indexOf("// Issue #1035 / ADR 0124 決定5", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain("この `ready` の書き込みが");
    expect(body).toContain("ベクトルは書けている");
    expect(body).toContain("reembed");
    expect(body).toContain("embed-job-ready-write-fails.test.ts");
  });
});
