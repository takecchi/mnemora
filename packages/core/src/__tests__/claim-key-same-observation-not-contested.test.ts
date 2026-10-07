import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-835" };

/**
 * `runtime.test.ts` の `sequencedLlm` と同じ形（1回目=抽出、2回目=claim key 導出、
 * ...の順で呼ばれる前提の単純化）。設定した回数を超えて呼ばれたら例外を投げる。
 */
function sequencedLlm(responses: unknown[]): LLMProvider {
  const calls: StructuredRequest<unknown>[] = [];
  return {
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

describe("claim key の検出: 同じ observation の兄弟どうしを誤って contested にしない（Issue #835、ADR 0377、core の Fake）", () => {
  it("(R) 回帰の歯: 先行 observe の M1 が在るとき、後続の1回の observe が生む同じ claim key の2件（訂正の新値・旧値の言い直し）は、片方が M1 と contested になり、もう片方は active のまま残る", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "以前は京都に住んでいた", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "lived_in_city" }] },
      {
        memories: [
          { content: "現在、神戸に住んでいる", provenanceKind: "stated" },
          { content: "以前は京都に住んでいた", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "lived_in_city" },
          { subject: "user", predicate: "lived_in_city" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "以前は京都に住んでいた。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(first.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const m1Id = first.memoryIds[0]!;

    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "もう京都には住んでいません。いまは神戸に住んでいます。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(second.memoryIds).toHaveLength(2);
    const [newValueId, restatedOldValueId] = second.memoryIds as [string, string];

    expect(second.contestedDetection).toHaveLength(2);
    const newValueOutcome = second.contestedDetection!.find((d) => d.memoryId === newValueId)!;
    expect(newValueOutcome.matchCount).toBe(1);
    expect(newValueOutcome.result.kind).toBe("contested");
    if (newValueOutcome.result.kind !== "contested") throw new Error("unreachable");
    expect(newValueOutcome.result.withMemoryId).toBe(m1Id);

    const restatedOutcome = second.contestedDetection!.find(
      (d) => d.memoryId === restatedOldValueId,
    )!;
    expect(restatedOutcome.matchCount).toBe(0);
    expect(restatedOutcome.result.kind).toBe("no_conflict");

    const m1 = await stores.memoryStore.get(ctx, m1Id);
    const newValueMemory = await stores.memoryStore.get(ctx, newValueId);
    const restatedOldValueMemory = await stores.memoryStore.get(ctx, restatedOldValueId);
    expect(m1?.status).toBe("contested");
    expect(m1?.contestedWithId).toBe(newValueId);
    expect(newValueMemory?.status).toBe("contested");
    expect(newValueMemory?.contestedWithId).toBe(m1Id);
    expect(restatedOldValueMemory?.status).toBe("active");
    expect(restatedOldValueMemory?.contestedWithId ?? null).toBeNull();
  });

  it("(a) 1回の observe の2件が同じ claim key でも、互いに contested にならない（#835 の誤検出そのものの歯）", async () => {
    const llm = sequencedLlm([
      {
        memories: [
          { content: "去年は札幌で働いていた", provenanceKind: "stated" },
          { content: "今年は福岡で働いている", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "work_location" },
          { subject: "user", predicate: "work_location" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "去年は札幌で働いていました。今年は福岡で働いています。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(result.memoryIds).toHaveLength(2);
    expect(result.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);

    const memories = await Promise.all(
      result.memoryIds.map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect(memories.map((m) => m?.status)).toEqual(["active", "active"]);
    expect(memories.map((m) => m?.contestedWithId ?? null)).toEqual([null, null]);
  });

  it("(L) 失うもの: 1つの発話内の言い直しが2件の候補に分かれ、同じ claim key に当たっても、今後は互いに contested にならない", async () => {
    // 意図して受け入れた損失（ADR 0377「失うもの」）: 1つの発話内の言い直しが2件に分かれて同じ claim key に当たっても、同じ observation の兄弟なので contested にならない。
    const llm = sequencedLlm([
      {
        memories: [
          { content: "定例会議は水曜日に変更", provenanceKind: "stated" },
          { content: "定例会議は金曜日ではない", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "meeting_day" },
          { subject: "user", predicate: "meeting_day" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "すみません、やはり定例会議は水曜日に移してください。金曜日は都合が悪くなりました。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(result.memoryIds).toHaveLength(2);
    expect(result.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const memories = await Promise.all(
      result.memoryIds.map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect(memories.map((m) => m?.status)).toEqual(["active", "active"]);
  });
});
