import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * claim key の自動 contested 検出（ADR 0324）で、同じ鍵の主張が1件ずつ届く経路の今の振る舞い
 * （Issue #933。`docs/memory-model.md` §5 の 2026-09-28 追記、ADR 0324 の 2026-09-27 追記）。
 *
 * 毎回 `detectContested: true` を渡して1件ずつ observe すると、2件目で1件目と対になって両方 `contested` になり、
 * `findActiveByClaimKey`（`active` だけ）の一致から外れる。⟹ 3件目は `no_conflict` で `active` のまま痕跡を
 * 残さず、4件目は3件目と新しい対になる。`claim_key_conflict_unresolved` のイベントは一度も積まれない。
 *
 * ⚠ 望ましい姿の主張ではない（直していない。方針は Issue #933 で決まっていない）。直すときは、この歯ごと
 * 書き換えること。Postgres でも同じことを `packages/postgres/src/__tests__/claim-key-sequential-arrival.postgres.test.ts`
 * が縛る。
 */

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

describe("claim key の検出: 同じ鍵の主張が1件ずつ届く経路（Issue #933、今の振る舞い。core の Fake）", () => {
  it("3件目は no_conflict で active のまま痕跡を残さず、4件目は3件目と新しい対になり、unresolved のイベントは積まれない", async () => {
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

    const results = [];
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
    ).toEqual([[[0, "no_conflict"]], [[1, "contested"]], [[0, "no_conflict"]], [[1, "contested"]]]);

    const memories = await Promise.all(ids.map((id) => stores.memoryStore.get(ctx, id)));
    expect(memories.map((m) => m?.status)).toEqual([
      "contested",
      "contested",
      "contested",
      "contested",
    ]);
    // 対は (1件目, 2件目) と (3件目, 4件目)。3件目は1件目・2件目とは結ばれない。
    expect(memories[0]?.contestedWithId).toBe(ids[1]);
    expect(memories[1]?.contestedWithId).toBe(ids[0]);
    expect(memories[2]?.contestedWithId).toBe(ids[3]);
    expect(memories[3]?.contestedWithId).toBe(ids[2]);

    // 決定6の「3件以上が並んだ件数を数えられる」evidence は、どの Memory にも積まれない。
    for (const id of ids) {
      const events = await stores.eventStore.list(ctx, { memoryId: id });
      expect(
        events.filter(
          (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
        ),
      ).toEqual([]);
    }
  });

  it("3件目を observe した直後は、3件目は active で contestedWithId を持たない", async () => {
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
    const memory = await stores.memoryStore.get(ctx, third!.memoryIds[0]!);
    expect(memory?.status).toBe("active");
    expect(memory?.contestedWithId ?? null).toBeNull();
  });
});
