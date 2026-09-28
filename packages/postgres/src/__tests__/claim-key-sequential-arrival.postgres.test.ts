import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryStore, StructuredRequest } from "@mnemora/core";
import { createRuntime, ExtractionResultSchema } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * claim key の自動 contested 検出（ADR 0324）で、同じ鍵の主張が1件ずつ届く経路の今の振る舞いを、
 * `@mnemora/postgres` で縛る（Issue #933。core の Fake での同じ歯は
 * `packages/core/src/__tests__/claim-key-sequential-arrival.test.ts`）。
 *
 * 毎回 `detectContested: true` を渡して1件ずつ observe すると、3件目は `no_conflict` で `active` のまま痕跡を
 * 残さず、4件目は3件目と新しい対になる。`claim_key_conflict_unresolved` のイベントは一度も積まれない。
 * ⚠ 望ましい姿の主張ではない（直していない）。直すときは、この歯ごと書き換えること。
 */

const ctx: Ctx = { tenantId: "claim-key-sequential-933" };
const CLAIMS = [
  "好きな食べ物はラーメン",
  "好きな食べ物は寿司",
  "好きな食べ物はカレー",
  "好きな食べ物は餃子",
];

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

afterAll(async () => {
  await closeTestClient();
});

describe("claim key の検出: 同じ鍵の主張が1件ずつ届く経路（Issue #933、今の振る舞い。@mnemora/postgres）", () => {
  it("3件目は no_conflict で痕跡を残さず、4件目は3件目と新しい対になり、unresolved のイベントは積まれない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore: MemoryStore = new PostgresMemoryStore(db);
    const eventStore: EventStore = new PostgresEventStore(db);
    const runtime = createRuntime({
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      eventStore,
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: sameKeyLlm(),
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content: string) => `sha256(${content})`,
    });

    const results = [];
    const statusAfterEach: string[] = [];
    for (const text of CLAIMS) {
      const result = await runtime.observe(ctx, {
        kind: "utterance",
        text,
        claimKey: { enabled: true, detectContested: true },
      });
      results.push(result);
      statusAfterEach.push((await memoryStore.get(ctx, result.memoryIds[0]!))!.status);
    }
    const ids = results.map((r) => r.memoryIds[0]!);

    expect(
      results.map((r) => r.contestedDetection?.map((d) => [d.matchCount, d.result.kind])),
    ).toEqual([[[0, "no_conflict"]], [[1, "contested"]], [[0, "no_conflict"]], [[1, "contested"]]]);
    // 3件目は、observe した直後は active（1件目・2件目と結ばれない）。
    expect(statusAfterEach).toEqual(["active", "contested", "active", "contested"]);

    const memories = await Promise.all(ids.map((id) => memoryStore.get(ctx, id)));
    expect(memories.map((m) => m?.contestedWithId)).toEqual([ids[1], ids[0], ids[3], ids[2]]);

    for (const id of ids) {
      const events = await eventStore.list(ctx, { memoryId: id });
      expect(
        events.filter(
          (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
        ),
      ).toEqual([]);
    }
  });
});
