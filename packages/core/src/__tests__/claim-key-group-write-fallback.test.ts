import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `relationStore` を配線した呼び出しで、3件が同じ claim key で競合して群を書こうとしたが、
 * 書き込みが CAS に弾かれて群にならなかったとき（`outcome.kind` が `contested_group` でない）は、
 * 群を名乗らず、`relationStore` を配線しない呼び出しと同じ形（`unresolved_conflict`・evidence の追記）に戻る。
 * 状態は動かさない（3件目は `active` のまま）。
 */

const ctx: Ctx = { tenantId: "tenant-group-write-fallback" };
const CLAIM_KEY = { subject: "user", predicate: "address" };

function sameKeyLlm(contents: string[]): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = contents[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [CLAIM_KEY] });
    },
  };
}

describe("claim key の検出: 群の書き込みが弾かれたら、群を名乗らず evidence だけに戻る", () => {
  it("markContestedGroup が CAS 競合になると、unresolved_conflict になり evidence が積まれ、3件目は active のまま", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: sameKeyLlm(["住所は東京", "住所は大阪", "住所は名古屋"]),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      relationStore: stores.relationStore,
    });
    // 群の書き込みだけが、CAS 競合で弾かれる。
    stores.memoryStore.markContestedGroup = async (_ctx, members) => {
      throw new MemoryStatusConflictError(members[0]!.id, "active", "forgotten");
    };

    const overlapping = (from: string, until: string) => ({
      validFrom: new Date(from),
      validUntil: new Date(until),
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      ...overlapping("2020-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      ...overlapping("2020-06-01T00:00:00Z", "2025-06-01T00:00:00Z"),
    });
    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は名古屋",
      claimKey: { enabled: true, detectContested: true },
      ...overlapping("2020-09-01T00:00:00Z", "2025-09-01T00:00:00Z"),
    });

    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);
    const thirdId = third.memoryIds[0]!;
    expect((await stores.memoryStore.get(ctx, thirdId))?.status).toBe("active");
    const events = await stores.eventStore.list(ctx, { memoryId: thirdId });
    const evidence = events.filter(
      (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
    );
    expect(evidence).toHaveLength(1);
  });
});
