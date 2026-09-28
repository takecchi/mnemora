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
 * `OutboxJob.lastError` の TSDoc（`packages/core/src/outbox.ts`、Issue #1064）: `@mnemora/postgres` で DB への書き込みが
 * 失敗したときの文面は、失敗したクエリの文と params をそのまま含むので、利用者の本文が丸ごと入る（今の振る舞い）。
 *
 * 書き込みを失敗させるのには、`outbox-fail-nul-last-error.postgres.test.ts` と同じく、抽出結果の本文に NUL を入れる
 * （Postgres の `text` は NUL を保存できない）。本文は合成したもの（目印の uuid を含む）で、実データではない。
 * ⚠ 望ましい姿の主張ではない（削る・上限を置くかは決まっていない）。直すときは、この歯ごと書き換えること。
 */

const ctx: Ctx = { tenantId: `outbox-last-error-body-${randomUUID()}` };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

describe("OutboxJob.lastError は、失敗したクエリの params（利用者の本文）を削らずに含む（Issue #1064、今の振る舞い）", () => {
  it("extract ジョブの書き込みが失敗すると、lastError に合成の本文の目印がそのまま入る", async () => {
    const { db, pool } = await getTestClient();
    const marker = `合成の本文の目印-${randomUUID()}`;
    const body = `${marker} ${"あ".repeat(2000)}\u0000末尾`;
    const llmProvider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async (_ctx, req) =>
        req.schema.parse({ memories: [{ content: body, provenanceKind: "stated" }] }),
    };
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
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

    await runtime.observe(ctx, { kind: "utterance", text: "元の発話", extract: "deferred" });
    const result = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 1 });
    expect(result.failed).toBe(1);

    const row = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM outbox WHERE tenant_id = $1 AND kind = 'extract'`,
      [ctx.tenantId],
    );
    const lastError = row.rows[0]?.last_error ?? "";
    // 失敗したクエリの文と params が載る（drizzle の文面）。
    expect(lastError).toContain("Failed query");
    expect(lastError).toContain("params:");
    // 合成の本文の目印と、後ろの2000字が削られずに入る。
    expect(lastError).toContain(marker);
    expect(lastError).toContain("あ".repeat(2000));
    expect(lastError.length).toBeGreaterThan(body.length);
  });
});
