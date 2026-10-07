import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryId, MemoryStore, Runtime } from "@mnemora/core";
import {
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
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

/** 半角空白・全角空白（U+3000）・改行・タブ。`trim()` で空になる。 */
const BLANK = " 　\n\t";
const OBSERVED_TEXT = "来週の月曜に歯医者の予約がある";
const EXTRACTOR_VERSION = "blank-content-v1";

/** 抽出だけ、最初の1回は投げられるようにする（reextract の前提の全文フォールバックを作るため）。 */
function makeLlm(state: { failNextExtraction: boolean }): LLMProvider {
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      const schema = req.schema as unknown;
      if (schema === ExtractionResultSchema) {
        if (state.failNextExtraction) {
          state.failNextExtraction = false;
          throw new Error("LLM が落ちた（テストの偽物）");
        }
        return req.schema.parse({ memories: [{ content: BLANK, provenanceKind: "stated" }] });
      }
      if (schema === ConsolidationLLMResultSchema) {
        return req.schema.parse({ content: BLANK });
      }
      if (schema === ReflectionLLMResultSchema) {
        return req.schema.parse({ outcome: "reflected", content: BLANK });
      }
      throw new Error("unexpected schema");
    },
  };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmState: { failNextExtraction: boolean };
}

function shared(llmState: { failNextExtraction: boolean }) {
  return {
    llmProvider: makeLlm(llmState),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    clock: { now: () => new Date(Date.now() + 60_000) },
    config: { extractorVersion: EXTRACTOR_VERSION },
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const llmState = { failNextExtraction: false };
      const memoryStore = new InMemoryMemoryStore();
      return {
        llmState,
        memoryStore,
        runtime: createRuntime({
          ...shared(llmState),
          memoryStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const llmState = { failNextExtraction: false };
      const memoryStore = new PostgresMemoryStore(db);
      return {
        llmState,
        memoryStore,
        runtime: createRuntime({
          ...shared(llmState),
          memoryStore,
          outboxStore: new PostgresOutboxStore(db),
          vectorStore: new PostgresVectorStore(db),
          eventStore: new PostgresEventStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "llm-blank-content" };

async function seedTwo(memoryStore: MemoryStore): Promise<MemoryId[]> {
  const ids: MemoryId[] = [];
  for (const hash of ["blank-content-a", "blank-content-b"]) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: hash, content: hash }),
    );
    ids.push(memory.id);
  }
  return ids;
}

afterAll(async () => {
  await closeTestClient();
});

describe("LLM が返した空白だけの本文は、LLM の失敗として扱い、Memory を書かない", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it("抽出（inline）: 全文フォールバックへ倒れる", async () => {
        const { runtime, memoryStore } = await makeKit();
        const result = await runtime.observe(ctx, { kind: "utterance", text: OBSERVED_TEXT });

        expect(result.extraction).toBe("llm_failed_whole_observation");
        expect(result.memoryIds).toHaveLength(1);
        const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
        expect(memory?.content).toBe(OBSERVED_TEXT);
      });

      it("抽出（deferred、tick の extract ジョブ）: 全文フォールバックへ倒れる", async () => {
        const { runtime, memoryStore } = await makeKit();
        const { observationId } = await runtime.observe(ctx, {
          kind: "utterance",
          text: OBSERVED_TEXT,
          extract: "deferred",
        });
        await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000, limit: 10 });

        const memories = await memoryStore.listBySourceObservation(
          ctx,
          observationId,
          EXTRACTOR_VERSION,
        );
        expect(memories.map((m) => m.content)).toEqual([OBSERVED_TEXT]);
      });

      it("reextract: 全文フォールバックの Memory を空白で置き換えない", async () => {
        const { runtime, memoryStore, llmState } = await makeKit();
        llmState.failNextExtraction = true;
        const observed = await runtime.observe(ctx, { kind: "utterance", text: OBSERVED_TEXT });
        expect(observed.extraction).toBe("llm_failed_whole_observation");
        const fallbackId = observed.memoryIds[0]!;

        const result = await runtime.reextract(ctx, observed.observationId);

        expect(result.extraction).toBe("llm_failed_whole_observation");
        expect(result.supersededMemoryIds).toEqual([]);
        const fallback = await memoryStore.get(ctx, fallbackId);
        expect(fallback?.status).toBe("active");
        expect(fallback?.content).toBe(OBSERVED_TEXT);
      });

      it("consolidate: llm_failed で、元の2件は active のまま", async () => {
        const { runtime, memoryStore } = await makeKit();
        const ids = await seedTwo(memoryStore);

        const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } });

        expect(result.outcome).toBe("llm_failed");
        expect(result.consolidatedMemoryId).toBeNull();
        expect(result.llmFailure).not.toBeNull();
        for (const id of ids) {
          expect((await memoryStore.get(ctx, id))?.status).toBe("active");
        }
      });

      it("reflect: llm_failed で、1件も書かない", async () => {
        const { runtime, memoryStore } = await makeKit();
        const ids = await seedTwo(memoryStore);

        const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });

        expect(result.outcome).toBe("llm_failed");
        expect(result.reflectedMemoryId).toBeNull();
        expect(result.llmFailure).not.toBeNull();
      });
    });
  }
});
