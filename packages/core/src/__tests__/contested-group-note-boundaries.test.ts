import { describe, expect, it } from "vitest";
import { createRuntime } from "../runtime.js";
import { GROWTH_CTX, growthLlm } from "./contested-group-event-growth.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0431 の確かめ直し（Issue #1734、PR #1537）で足した歯。`note` の先頭10件の**境界**と、
 * 切るのは `note` だけで `observe()` の戻り値は全員のままであること、群の `note` の `matches` の並び。
 *
 * - ちょうど10件のときは切らず、印は false（`>` であって `>=` ではない）。11件で初めて true。
 * - 群の `note` の `matches` も、`memberIds` と同じく id の昇順。
 * - `observe()` の戻り値（`memberIds`・`matchMemoryIds`）は、切らずに全員。
 */

function build(withRelationStore: boolean) {
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
    ...(withRelationStore ? { relationStore: stores.relationStore } : {}),
  });
  return { stores, runtime };
}

async function observeN(n: number, withRelationStore: boolean) {
  const { stores, runtime } = build(withRelationStore);
  let last: Awaited<ReturnType<typeof runtime.observe>> | undefined;
  for (let i = 0; i < n; i++) {
    last = await runtime.observe(GROWTH_CTX, {
      kind: "utterance",
      text: `住所は場所${i}`,
      claimKey: { enabled: true, detectContested: true },
    });
  }
  return { stores, last: last! };
}

function lastNote(
  stores: ReturnType<typeof build>["stores"],
  reason: string,
): Record<string, unknown> {
  const notes = stores.eventStore.events
    .filter(
      (e) =>
        e.kind === "updated" &&
        (e.meta as { reason?: string } | null | undefined)?.reason === reason,
    )
    .map((e) => JSON.parse((e.meta as { note: string }).note) as Record<string, unknown>);
  return notes[notes.length - 1]!;
}

describe("群の note の境界（core Fake）", () => {
  it("ちょうど10人の群は切らない（memberIdsTruncated は false）", async () => {
    const { stores } = await observeN(10, true);
    const note = lastNote(stores, "contested");
    expect(note.memberCount).toBe(10);
    expect(note.memberIdsTruncated).toBe(false);
    expect(note.memberIds as string[]).toHaveLength(10);
  });

  it("11人の群は memberIds だけ切る。matches はちょうど10件なので切らない", async () => {
    const { stores } = await observeN(11, true);
    const note = lastNote(stores, "contested");
    expect(note.memberCount).toBe(11);
    expect(note.memberIdsTruncated).toBe(true);
    expect(note.memberIds as string[]).toHaveLength(10);
    expect(note.matchCount).toBe(10);
    expect(note.matchesTruncated).toBe(false);
    expect(note.matches as unknown[]).toHaveLength(10);
  });

  it("matches も id の昇順", async () => {
    const { stores } = await observeN(40, true);
    const note = lastNote(stores, "contested");
    const ids = (note.matches as { id: string }[]).map((m) => m.id);
    expect(ids).toHaveLength(10);
    expect(ids).toEqual([...ids].sort());
  });

  it("store が一致を降順で返しても、matches・memberIds は id の昇順の先頭10件", async () => {
    const { stores, runtime } = build(true);
    // 一致の並びは adapter が決める（昇順で返す実装ばかりとは限らない）。降順で返させる。
    const store = stores.memoryStore as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown[]>
    >;
    for (const method of ["findActiveByClaimKey", "findContestedByClaimKey"]) {
      const original = store[method]!.bind(stores.memoryStore);
      store[method] = async (...args: unknown[]) => [...(await original(...args))].reverse();
    }
    for (let i = 0; i < 40; i++) {
      await runtime.observe(GROWTH_CTX, {
        kind: "utterance",
        text: `住所は場所${i}`,
        claimKey: { enabled: true, detectContested: true },
      });
    }
    const note = lastNote(stores, "contested");
    const matchIds = (note.matches as { id: string }[]).map((m) => m.id);
    const memberIds = note.memberIds as string[];
    expect(matchIds).toEqual([...matchIds].sort());
    expect(memberIds).toEqual([...memberIds].sort());
  });

  it("observe() の戻り値の memberIds は、切らずに全員", async () => {
    const { last } = await observeN(12, true);
    const result = last.contestedDetection![0]!.result;
    expect(result.kind).toBe("contested_group");
    if (result.kind === "contested_group") {
      expect(result.memberIds).toHaveLength(12);
    }
  });
});

describe("claim_key_conflict_unresolved の note の境界（core Fake）", () => {
  it("一致がちょうど10件なら切らない（matchesTruncated は false）", async () => {
    const { stores } = await observeN(11, false);
    const note = lastNote(stores, "claim_key_conflict_unresolved");
    expect(note.matchCount).toBe(10);
    expect(note.matchesTruncated).toBe(false);
    expect(note.matches as unknown[]).toHaveLength(10);
  });

  it("observe() の戻り値の matchMemoryIds は、切らずに全員", async () => {
    const { last } = await observeN(13, false);
    const result = last.contestedDetection![0]!.result;
    expect(result.kind).toBe("unresolved_conflict");
    if (result.kind === "unresolved_conflict") {
      expect(result.matchMemoryIds).toHaveLength(12);
    }
  });
});
