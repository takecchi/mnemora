import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * この歯は「今は contested になる」ことを記録する（Issue #835 U1、直し方は実 API の測定待ち）。
 * 案1 などで塞いで、この対が contested にならなくなったら赤くなる。
 * そのときは ADR 0329・0335・0377 と claim-key.ts の TSDoc を読み直し、歯を替えること。
 */

const ctx: Ctx = { tenantId: "tenant-835" };

function sequencedLlm(responses: unknown[]): LLMProvider & { calls: StructuredRequest<unknown>[] } {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    calls,
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      const index = calls.length;
      calls.push(req as StructuredRequest<unknown>);
      if (index >= responses.length) {
        throw new Error(`sequencedLlm: no response configured for call #${index + 1}`);
      }
      return req.schema.parse(responses[index]) as T;
    },
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

const FIRST_TEXT = "新しい趣味を始めようと思っています。";
const SECOND_TEXT = "旅行の計画を立てています。";

function script() {
  return [
    { memories: [{ content: "新しい趣味を始めようと思っている", provenanceKind: "stated" }] },
    { claims: [{ subject: "user", predicate: "new_hobby_intent" }] },
    { memories: [{ content: "旅行の計画を立てている", provenanceKind: "stated" }] },
    // スタブは語彙ヒントに入っていた predicate をそのまま返す（吸い寄せ）。
    { claims: [{ subject: "user", predicate: "new_hobby_intent" }] },
  ];
}

describe("claim key の検出: knownPredicatesFromStore と detectContested を組むと、別 observation の無関係な対も contested になる（Issue #835、ADR 0329・0335・0377）", () => {
  it("今の振る舞い: 2つ目の claim key 呼び出しの語彙ヒントに new_hobby_intent が入り、無関係な2件が contested になって contestedWith が付く", async () => {
    const llm = sequencedLlm(script());
    const { runtime, stores } = buildRuntime(llm);
    const claimKey = {
      enabled: true,
      detectContested: true,
      knownPredicatesFromStore: true,
    } as const;

    const first = await runtime.observe(ctx, { kind: "utterance", text: FIRST_TEXT, claimKey });
    expect(llm.calls[1]!.prompt.system).not.toContain("new_hobby_intent");

    const second = await runtime.observe(ctx, { kind: "utterance", text: SECOND_TEXT, claimKey });
    expect(llm.calls[3]!.prompt.system).toContain("new_hobby_intent");

    const hobbyId = first.memoryIds[0]!;
    const travelId = second.memoryIds[0]!;
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested", withMemoryId: hobbyId }),
      }),
    ]);
    expect((await stores.memoryStore.get(ctx, hobbyId))?.status).toBe("contested");
    expect((await stores.memoryStore.get(ctx, travelId))?.status).toBe("contested");

    await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["embed"] });
    const recalled = await runtime.recall(ctx, { text: "趣味 旅行", limit: 10 });
    expect(recalled.memories.map((m) => m.memoryId).sort()).toEqual([hobbyId, travelId].sort());
    const hobby = recalled.memories.find((m) => m.memoryId === hobbyId);
    const travel = recalled.memories.find((m) => m.memoryId === travelId);
    expect(hobby?.contestedWith).toBe(travelId);
    expect(travel?.contestedWith).toBe(hobbyId);
  });

  it("対照: knownPredicatesFromStore を付けなければ、2つ目の語彙ヒントに new_hobby_intent は入らない", async () => {
    const llm = sequencedLlm(script());
    const { runtime } = buildRuntime(llm);
    const claimKey = { enabled: true, detectContested: true } as const;

    await runtime.observe(ctx, { kind: "utterance", text: FIRST_TEXT, claimKey });
    await runtime.observe(ctx, { kind: "utterance", text: SECOND_TEXT, claimKey });

    expect(llm.calls[3]!.prompt.system).not.toContain("new_hobby_intent");
  });
});
