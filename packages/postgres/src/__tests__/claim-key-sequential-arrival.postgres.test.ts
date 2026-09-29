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
 * claim key の自動 contested 検出（ADR 0324）で、同じ鍵の主張が1件ずつ届く経路の振る舞いを、
 * `@mnemora/postgres` で縛る（Issue #933。core の Fake での同じ歯は
 * `packages/core/src/__tests__/claim-key-sequential-arrival.test.ts`——直った理由・
 * 分岐の詳細はそちらの doc コメントを見ること。ここでは重複しない）。
 *
 * **ADR 0378（Issue #933 案2）で直った後**: `PostgresMemoryStore.findContestedByClaimKey`
 * を実装しているので、3件目・4件目は `findActiveByClaimKey`（`active`）+
 * `findContestedByClaimKey`（`contested`）を合わせた一致で `unresolved_conflict` になり、
 * `memory_events` に `claim_key_conflict_unresolved` の evidence が積まれる。1件目・2件目の
 * 対（`contested`/`contestedWithId`）は、3件目・4件目が届いても壊れない。
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

describe("claim key の検出: 同じ鍵の主張が1件ずつ届く経路（Issue #933、ADR 0378 で直った後。@mnemora/postgres）", () => {
  it("3件目・4件目は unresolved_conflict で matchCount が2件以上になり、evidence が積まれる。1・2件目の対は壊れない", async () => {
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
    ).toEqual([
      [[0, "no_conflict"]],
      [[1, "contested"]],
      [[2, "unresolved_conflict"]],
      [[3, "unresolved_conflict"]],
    ]);
    // 3件目・4件目は、observe した直後もどちらも active（誰とも対にならない）。
    expect(statusAfterEach).toEqual(["active", "contested", "active", "active"]);

    const memories = await Promise.all(ids.map((id) => memoryStore.get(ctx, id)));
    expect(memories.map((m) => m?.status)).toEqual(["contested", "contested", "active", "active"]);
    // 1件目・2件目の対は、3件目・4件目が届いても壊れない。
    expect(memories[0]?.contestedWithId).toBe(ids[1]);
    expect(memories[1]?.contestedWithId).toBe(ids[0]);
    expect(memories[2]?.contestedWithId ?? null).toBeNull();
    expect(memories[3]?.contestedWithId ?? null).toBeNull();

    // 決定6の evidence（直る前は一度も積まれなかった）は、3件目・4件目に積まれる。
    const unresolvedEventsFor = async (id: (typeof ids)[number]) => {
      const events = await eventStore.list(ctx, { memoryId: id });
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
  });
});
