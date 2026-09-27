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

/**
 * LLM が返した tags の空文字・空白だけの要素が、`Memory.tags` にも、`listLabels` の proposed
 * ラベルにも出ないこと（純関数の歯は `packages/core/src/__tests__/llm-blank-tags.test.ts`）。
 *
 * 【実測 2026-09-27】以前は Postgres と testkit の InMemory の両方で、`""`・`" "`・全角空白（U+3000） と
 * いう名前の proposed ラベルが、extract の inline / deferred・consolidate・reflect の全経路で
 * できていた。
 */

const BLANK_AND_REAL = ["", " ", "\u3000", "旅行"];
/** reflect のスキーマは `""` を拒む（`tags: z.array(z.string().min(1))`）ので、通る空白だけを渡す。 */
const BLANK_FOR_REFLECT = [" ", "\u3000", "旅行"];

const EXTRACTOR_VERSION = "blank-tags-v1";

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    const schema = req.schema as unknown;
    if (schema === ExtractionResultSchema) {
      return req.schema.parse({
        memories: [
          { content: `事実 ${Math.random()}`, provenanceKind: "stated", tags: BLANK_AND_REAL },
        ],
      });
    }
    if (schema === ConsolidationLLMResultSchema) {
      return req.schema.parse({ content: "統合した本文", tags: BLANK_AND_REAL });
    }
    if (schema === ReflectionLLMResultSchema) {
      return req.schema.parse({
        outcome: "reflected",
        content: "内省した本文",
        tags: BLANK_FOR_REFLECT,
      });
    }
    throw new Error("unexpected schema");
  },
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  // outbox の available_at（DB の now()）より runtime の時計を先に進める（operation-roundtrip-shape と同じ理由）。
  clock: { now: () => new Date(Date.now() + 60_000) },
  config: { extractorVersion: EXTRACTOR_VERSION },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
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
      const memoryStore = new PostgresMemoryStore(db);
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared,
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

const ctx: Ctx = { tenantId: "llm-blank-tags" };

async function seedTwo(memoryStore: MemoryStore): Promise<MemoryId[]> {
  const ids: MemoryId[] = [];
  for (const [hash, tag] of [
    ["blank-tags-a", "x"],
    ["blank-tags-b", "y"],
  ] as const) {
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: hash,
        content: hash,
        tags: [tag],
      }),
    );
    ids.push(memory.id);
  }
  return ids;
}

/** 経路を1つ走らせ、LLM が作った Memory の id を返す。 */
const PATHS: Array<[string, (kit: Kit) => Promise<MemoryId>]> = [
  [
    "extract（inline）",
    async ({ runtime }) => {
      const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
      return result.memoryIds[0]!;
    },
  ],
  [
    "extract（deferred）",
    async ({ runtime, memoryStore }) => {
      const { observationId } = await runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
      });
      await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000, limit: 10 });
      const [memory] = await memoryStore.listBySourceObservation(
        ctx,
        observationId,
        EXTRACTOR_VERSION,
      );
      return memory!.id;
    },
  ],
  [
    "consolidate",
    async ({ runtime, memoryStore }) => {
      const ids = await seedTwo(memoryStore);
      const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
      return result.consolidatedMemoryId!;
    },
  ],
  [
    "reflect",
    async ({ runtime, memoryStore }) => {
      const ids = await seedTwo(memoryStore);
      const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });
      return result.reflectedMemoryId!;
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe("LLM が返した tags の空文字・空白だけの要素は、tags にもラベルにも出ない", () => {
  for (const [kitName, makeKit] of KITS) {
    describe(kitName, () => {
      it.each(PATHS)("%s", async (_path, run) => {
        const kit = await makeKit();
        const memoryId = await run(kit);

        const memory = await kit.memoryStore.get(ctx, memoryId);
        expect(memory?.tags).toEqual(["旅行"]);
        const labelNames = (await kit.memoryStore.listLabels!(ctx)).map((label) => label.name);
        expect(labelNames.filter((name) => name.trim() === "")).toEqual([]);
        expect(labelNames).toContain("旅行");
      });
    });
  }
});
