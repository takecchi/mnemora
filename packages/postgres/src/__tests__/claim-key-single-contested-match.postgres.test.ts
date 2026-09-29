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
 * Issue #933 PR1、2026-09-30 の穴埋め（ADR 0378 追記）を `@mnemora/postgres` で縛る
 * ——core の Fake での同じ歯は
 * `packages/core/src/__tests__/claim-key-single-contested-match.test.ts`（詳しい説明は
 * そちら）。
 *
 * 一致がちょうど1件で、その1件が既に `contested` な場合（3件目の有効期間が、既に対に
 * なった1件目・2件目のうち片方とだけ重なる）、直す前は `markContested` へ進んで
 * `ineligible` になり、検出中の Memory は `active` のまま痕跡も残らなかった。直した後は
 * `unresolved_conflict` になり、`markContested` を呼ばず、evidence だけを積む。
 */

const ctx: Ctx = { tenantId: "claim-key-single-contested-933" };

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
      return req.schema.parse({ claims: [{ subject: "user", predicate: "address" }] });
    },
  };
}

afterAll(async () => {
  await closeTestClient();
});

describe("claim key の検出: 一致がちょうど1件で、その1件が既に contested な場合（Issue #933 PR1 の穴埋め。@mnemora/postgres）", () => {
  it("3件目の有効期間が対のうち片方とだけ重なる: markContested へ進まず unresolved_conflict になり、evidence が積まれる。対は壊れない", async () => {
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
      llmProvider: sameKeyLlm(["住所は東京", "住所は大阪", "住所は名古屋"]),
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content: string) => `sha256(${content})`,
    });

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2025-01-01T00:00:00Z"),
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2019-01-01T00:00:00Z"),
      validUntil: new Date("2021-01-01T00:00:00Z"),
    });
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested", withMemoryId: first.memoryIds[0] }),
      }),
    ]);

    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は名古屋",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2024-01-01T00:00:00Z"),
      validUntil: new Date("2026-01-01T00:00:00Z"),
    });

    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);

    const thirdMemory = await memoryStore.get(ctx, third.memoryIds[0]!);
    expect(thirdMemory?.status).toBe("active");
    expect(thirdMemory?.contestedWithId ?? null).toBeNull();

    const firstMemory = await memoryStore.get(ctx, first.memoryIds[0]!);
    const secondMemory = await memoryStore.get(ctx, second.memoryIds[0]!);
    expect(firstMemory?.status).toBe("contested");
    expect(firstMemory?.contestedWithId).toBe(second.memoryIds[0]);
    expect(secondMemory?.status).toBe("contested");
    expect(secondMemory?.contestedWithId).toBe(first.memoryIds[0]);

    const events = await eventStore.list(ctx, { memoryId: third.memoryIds[0]! });
    const unresolvedEvents = events.filter(
      (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
    );
    expect(unresolvedEvents).toHaveLength(1);
    const note = JSON.parse((unresolvedEvents[0]!.meta as { note: string }).note) as {
      matchCount: number;
      matches: Array<{ id: string; status: string }>;
    };
    expect(note.matchCount).toBe(1);
    expect(note.matches).toEqual([
      expect.objectContaining({ id: first.memoryIds[0], status: "contested" }),
    ]);

    const firstEvents = await eventStore.list(ctx, { memoryId: first.memoryIds[0]! });
    expect(
      firstEvents.filter(
        (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
      ),
    ).toEqual([]);
  });
});
