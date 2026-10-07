import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, ObserveInput, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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

/** この歯が縛るのは opt-in しなかった既定の呼び出しだけで、opt-in したときの振る舞いは `observe-event-data-document-title-extract-opt-in.postgres.test.ts` が縛る。直すときは、この歯ごと書き換えること。 */

const ctx: Ctx = { tenantId: "observe-data-title-1185" };
const hashContent = (content: string) => `sha256(${content})`;
const embeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
};

/** 呼ばれたプロンプトを記録し、`fail` なら投げる（全文フォールバックへ倒す）偽の LLM。 */
function recordingLlm(mode: "ok" | "fail") {
  const prompts: string[] = [];
  const llm: LLMProvider = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async (_ctx, req) => {
      prompts.push(JSON.stringify(req.prompt));
      if (mode === "fail") throw new Error("llm down");
      return req.schema.parse({
        memories: [{ content: "抽出した本文", provenanceKind: "stated" }],
      });
    },
  };
  return { llm, prompts };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

const KITS: Array<[string, (llm: LLMProvider) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (llmProvider) => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          llmProvider,
          embeddingProvider,
          hashContent,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (llmProvider) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      return {
        memoryStore,
        runtime: createRuntime({
          llmProvider,
          embeddingProvider,
          hashContent,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

function inputs() {
  const dataMarker = `data-の目印-${randomUUID()}`;
  const titleMarker = `title-の目印-${randomUUID()}`;
  const event: ObserveInput = {
    kind: "event",
    name: "ログインした",
    data: { note: dataMarker, nested: { deeper: dataMarker } },
  };
  const document: ObserveInput = { kind: "document", title: titleMarker, content: "文書の本文" };
  return { dataMarker, titleMarker, event, document };
}

describe.each(KITS)(
  "event の data・document の title は既定では抽出に渡らない（Issue #1185、opt-in しない既定の振る舞い）: %s",
  (_name, build) => {
    it("抽出のプロンプトに data・title は入らず、name・content は入る", async () => {
      const { dataMarker, titleMarker, event, document } = inputs();
      const { llm, prompts } = recordingLlm("ok");
      const { runtime } = await build(llm);
      await runtime.observe(ctx, event);
      await runtime.observe(ctx, document);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("ログインした");
      expect(prompts[0]).not.toContain(dataMarker);
      expect(prompts[1]).toContain("文書の本文");
      expect(prompts[1]).not.toContain(titleMarker);
    });

    it("LLM が失敗したときの全文フォールバックの本文は、event なら name だけ、document なら content だけ", async () => {
      const { dataMarker, titleMarker, event, document } = inputs();
      const { llm } = recordingLlm("fail");
      const { runtime, memoryStore } = await build(llm);
      const fromEvent = await runtime.observe(ctx, event);
      const fromDocument = await runtime.observe(ctx, document);
      expect(fromEvent.extraction).toBe("llm_failed_whole_observation");
      expect(fromDocument.extraction).toBe("llm_failed_whole_observation");
      const eventMemory = await memoryStore.get(ctx, fromEvent.memoryIds[0]!);
      const documentMemory = await memoryStore.get(ctx, fromDocument.memoryIds[0]!);
      expect(eventMemory?.content).toBe("ログインした");
      expect(documentMemory?.content).toBe("文書の本文");
      expect(JSON.stringify([eventMemory?.content, eventMemory?.digest])).not.toContain(dataMarker);
      expect(JSON.stringify([documentMemory?.content, documentMemory?.digest])).not.toContain(
        titleMarker,
      );
    });
  },
);
