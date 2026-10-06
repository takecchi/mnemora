import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の #1475 のすり抜け A13（ADR 0363 の追記・0399）。
 * `purge` の `embeddingCleanup.error` は、outbox の `last_error` と同じ整形（params 以降を落とし、4096字で切る）。
 * 約束のうち「4096字で切る」は、outbox 側の歯（ADR 0363 本文）にしかなく、`outcome.error` の経路には届いていなかった。
 * この経路だけ上限を 8192 字にずらしても既存の歯は赤にならなかった。
 * （クローンの決定: 0363:267- の追記がいまの約束。狭まった部分——params 以降を落とす・4096字で切る——も約束の内。）
 */
const ctx: Ctx = { tenantId: "tenant-embedding-cleanup-cap" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const CAP = 4096;

function forgottenMemory(): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
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
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    status: "forgotten",
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

/** `deleteAcrossSpaces` が、`message` の長さが `length` の `Error` を投げる purge の `embeddingCleanup.error`。 */
async function embeddingCleanupErrorFor(length: number): Promise<string> {
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
    clock: { now: () => new Date(Date.now() + 60_000) },
  });
  const memory = await stores.memoryStore.createMemory(ctx, forgottenMemory());
  stores.vectorStore.deleteAcrossSpaces = async () => {
    throw new Error("x".repeat(length));
  };
  const result = await runtime.purge(ctx, { memoryId: memory.id });
  const outcome = result.outcomes[0]!;
  expect(outcome.kind).toBe("purged");
  if (outcome.kind !== "purged" || outcome.embeddingCleanup === undefined) {
    throw new Error("embeddingCleanup が付いていない");
  }
  expect(outcome.embeddingCleanup.status).toBe("failed");
  return outcome.embeddingCleanup.error;
}

describe("purge の embeddingCleanup.error は 4096 字で切る（#1475 A13）", () => {
  it("4096字ちょうどは切らない", async () => {
    expect(await embeddingCleanupErrorFor(CAP)).toBe("x".repeat(CAP));
  });

  it("4097字は 4096 字で切り、切った印と元の長さが付く", async () => {
    expect(await embeddingCleanupErrorFor(CAP + 1)).toBe(
      `${"x".repeat(CAP)}… (truncated by mnemora, original length ${CAP + 1} chars)`,
    );
  });

  it("5000字（4096 と 8192 の間）も 4096 字で切る", async () => {
    const error = await embeddingCleanupErrorFor(5000);
    expect(error).toBe(`${"x".repeat(CAP)}… (truncated by mnemora, original length 5000 chars)`);
  });
});
