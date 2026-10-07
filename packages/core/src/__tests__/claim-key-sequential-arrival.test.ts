import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-933" };
const CLAIMS = [
  "好きな食べ物はラーメン",
  "好きな食べ物は寿司",
  "好きな食べ物はカレー",
  "好きな食べ物は餃子",
];

/** 抽出には発話をそのまま1件返し、claim key の導出にはいつも同じ鍵を返す偽の LLM。 */
function sameKeyLlm(): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = CLAIMS[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "favorite_food" }] });
    },
  };
}

describe("claim key の検出: 同じ鍵の主張が1件ずつ届く経路（Issue #933、ADR 0378 で直った後。core の Fake）", () => {
  it("3件目・4件目は unresolved_conflict で matchCount が2件以上になり、evidence が積まれる。1・2件目の対は壊れない", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: sameKeyLlm(),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });

    const results: Awaited<ReturnType<typeof runtime.observe>>[] = [];
    for (const text of CLAIMS) {
      results.push(
        await runtime.observe(ctx, {
          kind: "utterance",
          text,
          claimKey: { enabled: true, detectContested: true },
        }),
      );
    }
    const ids = results.map((r) => r.memoryIds[0]!);

    expect(
      results.map((r) => r.contestedDetection?.map((d) => [d.matchCount, d.result.kind])),
    ).toEqual([
      [[0, "no_conflict"]],
      [[1, "contested"]],
      [[2, "unresolved_conflict"]],
      [[3, "unresolved_conflict"]],
    ]);

    const matchIdsOf = (index: number): string[] => {
      const result = results[index]!.contestedDetection![0]!.result;
      if (result.kind !== "unresolved_conflict") throw new Error("unresolved_conflict ではない");
      return [...result.matchMemoryIds].sort();
    };
    expect(matchIdsOf(2)).toEqual([ids[0], ids[1]].sort());
    expect(matchIdsOf(3)).toEqual([ids[0], ids[1], ids[2]].sort());

    const memories = await Promise.all(ids.map((id) => stores.memoryStore.get(ctx, id)));
    expect(memories.map((m) => m?.status)).toEqual(["contested", "contested", "active", "active"]);
    expect(memories[0]?.contestedWithId).toBe(ids[1]);
    expect(memories[1]?.contestedWithId).toBe(ids[0]);
    expect(memories[2]?.contestedWithId ?? null).toBeNull();
    expect(memories[3]?.contestedWithId ?? null).toBeNull();

    const unresolvedEventsFor = async (id: (typeof ids)[number]) => {
      const events = await stores.eventStore.list(ctx, { memoryId: id });
      return events.filter(
        (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
      );
    };
    expect(await unresolvedEventsFor(ids[0]!)).toEqual([]);
    expect(await unresolvedEventsFor(ids[1]!)).toEqual([]);
    const thirdEvents = await unresolvedEventsFor(ids[2]!);
    expect(thirdEvents).toHaveLength(1);
    const thirdNote = JSON.parse((thirdEvents[0]!.meta as { note: string }).note) as {
      matchCount: number;
      matches: Array<{ id: string; status: string }>;
    };
    expect(thirdNote.matchCount).toBe(2);
    expect(thirdNote.matches.map((m) => m.status).sort()).toEqual(["contested", "contested"]);
    expect(thirdNote.matches.map((m) => m.id).sort()).toEqual([ids[0], ids[1]].sort());

    const fourthEvents = await unresolvedEventsFor(ids[3]!);
    expect(fourthEvents).toHaveLength(1);
    const fourthNote = JSON.parse((fourthEvents[0]!.meta as { note: string }).note) as {
      matchCount: number;
      matches: Array<{ id: string; status: string }>;
    };
    expect(fourthNote.matchCount).toBe(3);
    expect(fourthNote.matches.map((m) => m.status).sort()).toEqual([
      "active",
      "contested",
      "contested",
    ]);
    expect(fourthNote.matches.map((m) => m.id).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it("3件目を observe した直後は、3件目は active で contestedWithId を持たない（対にはならない）", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: sameKeyLlm(),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    let third;
    for (const text of CLAIMS.slice(0, 3)) {
      third = await runtime.observe(ctx, {
        kind: "utterance",
        text,
        claimKey: { enabled: true, detectContested: true },
      });
    }
    expect(third!.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);
    const memory = await stores.memoryStore.get(ctx, third!.memoryIds[0]!);
    expect(memory?.status).toBe("active");
    expect(memory?.contestedWithId ?? null).toBeNull();
  });
});
