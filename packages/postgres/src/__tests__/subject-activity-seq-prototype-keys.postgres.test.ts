import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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

const TENANT = "proto-keys-tenant";
const tenantCtx: Ctx = { tenantId: TENANT };
const KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];
const T = 10;

afterAll(async () => {
  await closeTestClient();
});

const recallInput = {
  tenantId: TENANT,
  query: { text: "q" },
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
    req.schema.parse({ memories: [{ content: "事実", provenanceKind: "stated" }] }) as U,
};

async function setup(rows: Record<string, number>) {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
  });
  await tenantSettingsStore.setDecayClock(tenantCtx, "activity");
  for (let i = 0; i < T; i += 1) {
    await memoryStore.createRecall(tenantCtx, {
      ...recallInput,
      subjectId: null,
      advanceActivityClock: true,
    });
  }
  for (const [subjectId, n] of Object.entries({ anchor: 3, ...rows })) {
    for (let i = 0; i < n; i += 1) {
      await memoryStore.createRecall(tenantCtx, {
        ...recallInput,
        subjectId,
        advanceActivityClock: { scope: "subject", subjectId },
      });
    }
  }
  return { db, runtime, tenantSettingsStore };
}

describe("ADR 0472: Object.prototype のキー名の subjectId（Postgres）", () => {
  it.each(KEYS)(
    "⭐ '%s' の行の値を getSubjectActivitySeqs が落とさず、行の無い plain は含めない",
    async (key) => {
      const { tenantSettingsStore } = await setup({ [key]: 4 });
      const seqs = await tenantSettingsStore.getSubjectActivitySeqs(tenantCtx, [key, "plain"]);
      expect(Object.hasOwn(seqs, key)).toBe(true);
      expect(seqs[key]).toBe(4);
      expect(Object.hasOwn(seqs, "plain")).toBe(false);
    },
  );

  it("陽性対照: plain の observe は 行なしなら T、行があれば T + S_x", async () => {
    for (const [rows, expected] of [
      [{}, T],
      [{ plain: 4 }, T + 4],
    ] as const) {
      const { db, runtime } = await setup(rows);
      const ctx: Ctx = { tenantId: TENANT, subjectId: "plain" };
      const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
      const row = await db.execute(sql`
        SELECT decay_base_seq::float8 AS base FROM memories
        WHERE tenant_id = ${TENANT} AND id = ${result.memoryIds[0]!}
      `);
      expect((row.rows[0] as { base: number }).base).toBe(expected);
    }
  });

  it.each(KEYS)(
    "⭐ '%s' の observe は活動時計の起点を T（行なし）／T + 4（行あり）で書く",
    async (key) => {
      for (const [rows, expected] of [
        [{}, T],
        [{ [key]: 4 }, T + 4],
      ] as const) {
        const { db, runtime } = await setup(rows);
        const ctx: Ctx = { tenantId: TENANT, subjectId: key };
        const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
        const row = await db.execute(sql`
        SELECT decay_base_seq::float8 AS base FROM memories
        WHERE tenant_id = ${TENANT} AND id = ${result.memoryIds[0]!}
      `);
        expect((row.rows[0] as { base: number }).base).toBe(expected);
      }
    },
  );
});
