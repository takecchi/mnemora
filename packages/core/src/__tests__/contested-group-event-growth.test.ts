import { describe, expect, it } from "vitest";
import { createRuntime } from "../runtime.js";
import {
  expectLinearGrowth,
  growthLlm,
  measureContestedGroupGrowth,
  type GrowthMeasurement,
} from "./contested-group-event-growth.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0431: 群の監査イベントの件数と `note` の大きさが、群の大きさ N に対して線形であること
 * （core の Fake 版。testkit の InMemory・Postgres の同じ歯は同じ部品を使う）。
 */

async function measure(n: number): Promise<GrowthMeasurement> {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: growthLlm(),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    relationStore: stores.relationStore,
  });
  return measureContestedGroupGrowth(runtime, async () => stores.eventStore.events, n);
}

describe("群の監査イベントは N に対して線形にしか増えない（core Fake）", () => {
  it("N=10/20/40: イベントの件数・note の長さ・meta の合計バイト数", async () => {
    const m = { 10: await measure(10), 20: await measure(20), 40: await measure(40) };
    expectLinearGrowth(m);
  });

  it("note は件数と先頭の一部だけを持ち、切ったことを印で示す", async () => {
    const m = await measure(40);
    const note = m.lastNote!;
    expect(note.kind).toBe("claim_key_conflict_group");
    expect(note.memberCount).toBe(40);
    expect(note.memberIdsTruncated).toBe(true);
    expect((note.memberIds as string[]).length).toBeLessThan(40);
    expect(note.matchCount).toBe(39);
    expect(note.matchesTruncated).toBe(true);
    expect((note.matches as unknown[]).length).toBeLessThan(39);
    const ids = note.memberIds as string[];
    expect(ids).toEqual([...ids].sort());
  });

  it("群が小さければ切らず、印は false", async () => {
    const m = await measure(4);
    const note = m.lastNote!;
    expect(note.memberCount).toBe(4);
    expect(note.memberIdsTruncated).toBe(false);
    expect((note.memberIds as string[]).length).toBe(4);
    expect(note.matchesTruncated).toBe(false);
    expect((note.matches as unknown[]).length).toBe(3);
  });
});
