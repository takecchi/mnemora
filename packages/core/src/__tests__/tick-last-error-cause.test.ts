import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

import type { NewMemory } from "../memory.js";

/**
 * Issue #969: `tick()` の `lastError` が `cause` の連鎖を辿ることの、Fake での歯。
 * 本物の drizzle/pg の包み方での歯は `packages/postgres` の
 * `tick-last-error-cause.postgres.test.ts` にある——ここでは連鎖の辿り方
 * （`code` の付け方・Error でない `cause`・循環）だけを測る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
// Fake の outbox 行の `availableAt` は実時刻で付くので、runtime の時計はそれより後にする。
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

async function lastErrorFor(thrown: unknown): Promise<string | null | undefined> {
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
    throw thrown;
  };
  const result = await runtime.tick(ctx, { leaseMs: 60_000 });
  expect(result.failed).toBe(1);
  return stores.outboxStore.listJobs(ctx)[0]?.lastError;
}

describe("tick() の lastError は cause の連鎖を辿る（Issue #969）", () => {
  it("各段の message と文字列の code を連結し、それ以外の欄（detail 等）は載せない", async () => {
    const root = Object.assign(new Error("connection reset"), {
      code: "ECONNRESET",
      detail: "secret-detail",
    });
    const lastError = await lastErrorFor(new Error("Failed query: SELECT 1", { cause: root }));
    expect(lastError).toBe(
      "Failed query: SELECT 1 <- caused by: connection reset (code: ECONNRESET)",
    );
  });

  it("cause が Error でなければ String() で1段だけ足して止まる", async () => {
    const lastError = await lastErrorFor(new Error("outer", { cause: "plain string cause" }));
    expect(lastError).toBe("outer <- caused by: plain string cause");
  });

  it("cause が循環していても止まる（一度見た段で打ち切る）", async () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const lastError = await lastErrorFor(a);
    expect(lastError).toBe("a <- caused by: b");
  });

  it("cause が無ければ今までどおり message だけ", async () => {
    expect(await lastErrorFor(new Error("just a message"))).toBe("just a message");
  });
});
