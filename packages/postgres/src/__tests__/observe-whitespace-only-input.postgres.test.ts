import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import type { Ctx, LLMProvider, ObserveInput } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const ctx: Ctx = { tenantId: "observe-whitespace-only-input" };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async () => {
    throw new Error("llm down");
  },
};
const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");
const embed = async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]);

type Kit = {
  observe: (input: ObserveInput) => Promise<unknown>;
  memoryContents: () => Promise<string[]>;
  observationCount: () => Promise<number>;
};

async function postgresKit(): Promise<Kit> {
  const { db, pool } = await getTestClient();
  const runtime = createRuntime({
    llmProvider: llm,
    embeddingProvider: { space: TEST_EMBEDDING_SPACE, embed },
    hashContent,
    memoryStore: new PostgresMemoryStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
  });
  return {
    observe: (input) => runtime.observe(ctx, input),
    memoryContents: async () =>
      (
        await pool.query(`SELECT content FROM memories WHERE tenant_id = $1`, [ctx.tenantId])
      ).rows.map((r) => r.content as string),
    observationCount: async () =>
      Number(
        (
          await pool.query(`SELECT count(*) AS n FROM observations WHERE tenant_id = $1`, [
            ctx.tenantId,
          ])
        ).rows[0].n,
      ),
  };
}

async function fixtureKit(): Promise<Kit> {
  const memoryStore = new InMemoryMemoryStore();
  const runtime = createRuntime({
    llmProvider: llm,
    embeddingProvider: { space: { provider: "test", model: "ws", dimensions: 3 }, embed },
    hashContent,
    memoryStore,
    vectorStore: new InMemoryVectorStore(memoryStore),
    eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
    outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
    tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
  });
  const backing = memoryStore as unknown as {
    observations: Map<string, unknown>;
    memories: Map<string, { content: string }>;
  };
  return {
    observe: (input) => runtime.observe(ctx, input),
    memoryContents: async () => [...backing.memories.values()].map((m) => m.content),
    observationCount: async () => backing.observations.size,
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["Postgres", postgresKit],
  ["fixture", fixtureKit],
];

const BLANK_INPUTS: Array<[string, ObserveInput]> = [
  ["utterance.text（半角空白）", { kind: "utterance", text: "   " }],
  ["utterance.text（U+3000）", { kind: "utterance", text: "　　" }],
  ["event.name（改行・タブ）", { kind: "event", name: "\n\t" }],
  ["event.name（U+3000）", { kind: "event", name: "　" }],
  ["document.content（改行）", { kind: "document", content: "\n\n  " }],
  ["document.content（U+3000）", { kind: "document", content: "　" }],
];

describe.each(KITS)("%s: 空白だけの本文", (_kitName, makeKit) => {
  it.each(BLANK_INPUTS)("%s は ZodError で断られ、何も残らない", async (_label, input) => {
    const kit = await makeKit();
    const err = await kit.observe(input).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.name).toBe("ZodError");
    expect(await kit.observationCount()).toBe(0);
    expect(await kit.memoryContents()).toEqual([]);
  });

  it("前後に空白のある普通の文は通り、Memory が残る（LLM 失敗の全文フォールバック）", async () => {
    const kit = await makeKit();
    await kit.observe({ kind: "utterance", text: "　 hello world \n" });
    expect(await kit.observationCount()).toBe(1);
    const contents = await kit.memoryContents();
    expect(contents).toHaveLength(1);
    expect(contents[0]!.trim()).toBe("hello world");
  });
});
