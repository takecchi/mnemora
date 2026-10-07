import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider } from "@mnemora/core";
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

/**
 * Postgres の `text` は NUL を保存できないので、`last_error = $1` の UPDATE そのものが失敗すると、`fail()` が例外を投げ、`tick()` がその場で打ち切られて同じ batch の後ろのジョブが処理されず、
 * 失敗したジョブは claim されたまま終端に落ちず、リースが切れるたびに再び claim されて同じ所で落ちる。
 * 実際に起きる経路: LLM の抽出結果の本文に NUL が入ると `memories` への INSERT が失敗し、drizzle のエラー文は params（その本文）をそのまま含み、`tick()` はそれを `lastError` に載せる。
 * NUL は、目に見える6文字の `\u0000` に置き換えて書く（黙って消さない）。
 */

const CTX: Ctx = { tenantId: `outbox-fail-nul-${randomUUID()}` };

describe("PostgresOutboxStore.fail — error に NUL が含まれていても終端の失敗を書ける", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("fail() は投げず、行は終端の失敗になり、NUL は目に見える \\u0000 で残る", async () => {
    const { pool, db } = await getTestClient();
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [CTX.tenantId],
    );
    const jobId = seeded.rows[0]!.id;
    const store = new PostgresOutboxStore(db);
    const [job] = await store.claimBatch(CTX, {
      limit: 1,
      now: new Date(Date.now() + 60_000),
      claimedBy: "nul-test",
      leaseMs: 60_000,
    });
    expect(job?.id).toBe(jobId);

    await expect(
      store.fail(CTX, jobId, "before\u0000after", job!.attempts),
    ).resolves.toBeUndefined();

    const row = await pool.query<{ failed_at: Date | null; last_error: string | null }>(
      `SELECT failed_at, last_error FROM outbox WHERE id = $1`,
      [jobId],
    );
    expect(row.rows[0]?.failed_at).not.toBeNull();
    expect(row.rows[0]?.last_error).toBe("before\\u0000after");
  });

  it("LLM の抽出結果に NUL が入った extract ジョブで、tick() は投げずに failed: 1 を返し、ジョブは再び claim されない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const outboxStore = new PostgresOutboxStore(db);
    const llmProvider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async (_ctx, req) =>
        req.schema.parse({ memories: [{ content: "壊れた\u0000本文", provenanceKind: "stated" }] }),
    };
    const runtime = createRuntime({
      memoryStore,
      outboxStore,
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider,
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content: string) => `sha256(${content})`,
    });

    await runtime.observe(CTX, { kind: "utterance", text: "元の発話", extract: "deferred" });

    const first = await runtime.tick(CTX, { kinds: ["extract"], leaseMs: 1 });
    expect(first).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });

    const again = await outboxStore.claimBatch(CTX, {
      kinds: ["extract"],
      limit: 10,
      now: new Date(Date.now() + 60_000),
      claimedBy: "nul-test",
      leaseMs: 1,
    });
    expect(again).toEqual([]);
  });
});
