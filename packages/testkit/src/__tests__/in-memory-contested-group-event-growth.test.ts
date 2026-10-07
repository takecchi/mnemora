import { describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import {
  expectLinearGrowth,
  growthLlm,
  measureContestedGroupGrowth,
  type GrowthMeasurement,
} from "../../../core/src/__tests__/contested-group-event-growth.js";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryRelationStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "../fixtures.js";

async function measure(n: number): Promise<GrowthMeasurement> {
  const memoryStore = new InMemoryMemoryStore();
  const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
    vectorStore: new InMemoryVectorStore(memoryStore),
    eventStore,
    tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
    llmProvider: growthLlm(),
    embeddingProvider: {
      space: { provider: "test", model: "growth", dimensions: 3 },
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    relationStore: new InMemoryRelationStore(memoryStore),
  });
  return measureContestedGroupGrowth(runtime, async () => memoryStore.events, n);
}

describe("群の監査イベントは N に対して線形にしか増えない（testkit InMemory）", () => {
  it("N=10/20/40: イベントの件数・note の長さ・meta の合計バイト数", async () => {
    const m = { 10: await measure(10), 20: await measure(20), 40: await measure(40) };
    expectLinearGrowth(m);
  });

  it("note は件数と先頭の一部だけを持ち、切ったことを印で示す", async () => {
    const note = (await measure(40)).lastNote!;
    expect(note.memberCount).toBe(40);
    expect(note.memberIdsTruncated).toBe(true);
    expect((note.memberIds as string[]).length).toBeLessThan(40);
    expect(note.matchCount).toBe(39);
    expect(note.matchesTruncated).toBe(true);
    const ids = note.memberIds as string[];
    expect(ids).toEqual([...ids].sort());
  });
});
