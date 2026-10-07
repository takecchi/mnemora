import { describe, expect, it } from "vitest";
import { createRuntime } from "../runtime.js";
import { GROWTH_CTX, growthLlm } from "./contested-group-event-growth.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

async function unresolvedNotes(n: number): Promise<Record<string, unknown>[]> {
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
  });
  for (let i = 0; i < n; i++) {
    await runtime.observe(GROWTH_CTX, {
      kind: "utterance",
      text: `住所は場所${i}`,
      claimKey: { enabled: true, detectContested: true },
    });
  }
  return stores.eventStore.events
    .filter(
      (e) =>
        e.kind === "updated" &&
        (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
    )
    .map((e) => JSON.parse((e.meta as { note: string }).note) as Record<string, unknown>);
}

describe("claim_key_conflict_unresolved の note は件数と先頭10件だけを持つ（core Fake）", () => {
  it("一致が多いとき、matches は id 昇順の先頭10件に切られ、matchCount と matchesTruncated が付く", async () => {
    const notes = await unresolvedNotes(40);
    expect(notes.length).toBeGreaterThan(0);
    const last = notes[notes.length - 1]!;
    expect(last.kind).toBe("claim_key_conflict_unresolved");
    const matchCount = last.matchCount as number;
    expect(matchCount).toBeGreaterThan(10);
    const matches = last.matches as { id: string }[];
    expect(matches).toHaveLength(10);
    expect(last.matchesTruncated).toBe(true);
    const ids = matches.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("一致が10件以下なら切らず、matchesTruncated は false", async () => {
    const notes = await unresolvedNotes(5);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect((note.matches as unknown[]).length).toBe(note.matchCount);
      expect(note.matchesTruncated).toBe(false);
    }
  });

  it("note の長さは一致の件数に依らない上限に収まる（N=20 と N=40 でほぼ同じ）", async () => {
    const maxLen = async (n: number) =>
      Math.max(...(await unresolvedNotes(n)).map((note) => JSON.stringify(note).length));
    const [len20, len40] = [await maxLen(20), await maxLen(40)];
    expect(len40 - len20).toBeLessThan(40);
  });
});
