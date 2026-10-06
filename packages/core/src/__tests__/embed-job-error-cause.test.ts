import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #962（前半）: `processEmbedJob` は埋め込みの失敗を受けて `embeddingStatus: 'failed'`
 * を書いてから元の例外を投げ直す。その `failed` の書き込み自体が失敗すると、元の例外
 * （なぜ埋め込めなかったか）が失われ、outbox 行の `lastError` には二次的な失敗しか残らなかった。
 * 元の例外は `cause` に残し、`lastError` にも両方が載ることを測る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
// 以前の Fake は outbox 行の `availableAt` を実時刻で付けたため、runtime の時計を実時刻より後にしている。今の Fake は `opts.now` に従う（ADR 0555）ので、この置き方は必須ではない（組み替えは ADR 0555 の「残り」）。
const LATER = new Date(Date.now() + 60_000);

function newMemory(): NewMemory {
  const recordedAt = LATER;
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

describe("processEmbedJob — failed の書き込みが失敗しても元の例外を失わない（Issue #962）", () => {
  it("lastError に元の例外（埋め込みの失敗）と二次的な失敗の両方が載る", async () => {
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
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    stores.embeddingProvider.embed = async () => {
      throw new Error("embedding provider down");
    };
    stores.memoryStore.setEmbeddingStatus = async () => {
      throw new Error("db connection reset while marking failed");
    };

    const result = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(result.failed).toBe(1);
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.lastError).toContain("embedding provider down");
    expect(job?.lastError).toContain("db connection reset while marking failed");
  });
});

/**
 * `lastError` の形を測る。`cause` の連鎖は `describeFailure` が `<- caused by:` でつなぐので、
 * 公開の口（`tick()` → outbox 行の `lastError`）から `cause` の中身が見える。
 */
async function tickWithFailingEmbed(opts: {
  embedMessage: string;
  markFailedMessage: string | null;
}): Promise<string | undefined> {
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
  await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
  stores.embeddingProvider.embed = async () => {
    throw new Error(opts.embedMessage);
  };
  const markFailedMessage = opts.markFailedMessage;
  if (markFailedMessage !== null) {
    stores.memoryStore.setEmbeddingStatus = async () => {
      throw new Error(markFailedMessage);
    };
  }
  const result = await runtime.tick(ctx, { leaseMs: 60_000 });
  expect(result.failed).toBe(1);
  return stores.outboxStore.listJobs(ctx)[0]?.lastError ?? undefined;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("processEmbedJob — lastError の形（Issue #962）", () => {
  it("failed の書き込みが成功したときは、元の例外をそのまま投げ直す（包まない）", async () => {
    const lastError = await tickWithFailingEmbed({
      embedMessage: "embedding provider down",
      markFailedMessage: null,
    });

    expect(lastError).toBe("embedding provider down");
  });

  it("failed の書き込みが失敗したとき、元の例外は cause に残る（二次的な失敗を cause にしない）", async () => {
    const lastError = await tickWithFailingEmbed({
      embedMessage: "embedding provider down",
      markFailedMessage: "db connection reset while marking failed",
    });

    expect(lastError).toBeDefined();
    // 連鎖の末尾が元の例外。メッセージ本文に1回、cause として1回、計2回。二次的な失敗は本文に1回だけ。
    expect(lastError!.endsWith(" <- caused by: embedding provider down")).toBe(true);
    expect(countOccurrences(lastError!, "embedding provider down")).toBe(2);
    expect(countOccurrences(lastError!, "db connection reset while marking failed")).toBe(1);
  });

  it("二次的な失敗の文面が長く、lastError の上限で連鎖の後ろが切れても、元の例外は本文に残る", async () => {
    const lastError = await tickWithFailingEmbed({
      embedMessage: "embedding provider down",
      markFailedMessage: `db connection reset ${"x".repeat(6000)}`,
    });

    expect(lastError).toBeDefined();
    expect(lastError).toContain("truncated by mnemora");
    expect(lastError).toContain("embedding provider down");
  });
});
