import { afterAll, beforeEach, expect, it } from "vitest";
import { createRuntime, type PromptSpec } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

beforeEach(resetTestDatabase);
afterAll(closeTestClient);
it("persisted context survives a new runtime and deferred extraction/reextraction", async () => {
  const { db } = await getTestClient();
  const prompts: PromptSpec[] = [];
  const create = () =>
    createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      hashContent: sha256Hex,
      embeddingProvider: { space: TEST_EMBEDDING_SPACE, embed: async () => [[1, 0, 0]] },
      llmProvider: {
        complete: async () => {
          throw new Error("unused");
        },
        completeStructured: async (_ctx, req) => {
          prompts.push(req.prompt);
          return req.schema.parse({
            memories: [{ content: "青葉を選択", provenanceKind: "stated" }],
          });
        },
      },
    });
  const ctx = { tenantId: "context-roundtrip" };
  const result = await create().observe(ctx, {
    kind: "utterance",
    text: "それでお願いします",
    speaker: "田中",
    extract: "deferred",
    occurredAt: new Date("2026-01-01T23:00:00Z"),
    extractionContext: {
      messages: [{ text: "会議室は青葉でよいですか？", speaker: "assistant" }],
      timeZone: "Asia/Tokyo",
    },
  });
  expect(prompts).toHaveLength(0);
  expect((await create().tick(ctx, { kinds: ["extract"], leaseMs: 60000 })).failed).toBe(0);
  await create().reextract(ctx, result.observationId);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toEqual(prompts[0]);
  expect(JSON.parse(prompts[0]!.messages[0]!.content)).toMatchObject({
    observation: { speaker: "田中", observedLocalDate: "2026-01-02" },
    context: [{ text: "会議室は青葉でよいですか？", speaker: "assistant" }],
  });
});
