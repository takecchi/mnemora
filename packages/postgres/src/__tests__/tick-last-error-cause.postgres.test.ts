import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * Issue #969: `tick()` がジョブの失敗を `outboxStore.fail()` に記録する `lastError` は、
 * `err.message` だけだった。drizzle の `db.execute()` は pg のエラーを
 * `Failed query: <SQL> params: …` で包むので、DB 由来の失敗では**理由（pg のエラー文・
 * SQLSTATE）が `cause` にしか無く、`lastError` に残らなかった**。
 *
 * ここでは `memories` への UPDATE をトリガーで `RAISE EXCEPTION` させ、本物の drizzle/pg の
 * 包み方で失敗させる。`lastError` に理由と SQLSTATE が載ること、そして pg エラーの
 * `detail`（制約違反のキー値など、利用者のデータが入りうる欄）は載せないことを測る。
 */
afterAll(async () => {
  const { db } = await getTestClient();
  await db.execute(sql`DROP TRIGGER IF EXISTS tick_last_error_probe ON memories`);
  await db.execute(sql`DROP FUNCTION IF EXISTS tick_last_error_probe_fn()`);
  await closeTestClient();
});

describe("tick() の lastError は cause の連鎖の理由も載せる（Issue #969、本物の Postgres）", () => {
  it("DB がジョブの書き込みを拒否すると、lastError に pg のエラー文と SQLSTATE が載り、detail は載らない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
      hashContent: sha256Hex,
    });
    const ctx: Ctx = { tenantId: "tenant-last-error" };
    await runtime.observe(ctx, { kind: "utterance", text: "ジョブの失敗理由を残す", speaker: "u" });

    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION tick_last_error_probe_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.embedding_status = 'ready' AND OLD.embedding_status <> 'ready' THEN
            RAISE EXCEPTION 'probe: embedding_status ready rejected'
              USING ERRCODE = 'P0001', DETAIL = 'secret-detail-value-must-not-leak';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql`CREATE TRIGGER tick_last_error_probe BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION tick_last_error_probe_fn()`,
    );
    const result = await runtime.tick(ctx, { leaseMs: 60_000 });
    await db.execute(sql`DROP TRIGGER tick_last_error_probe ON memories`);

    expect(result.failed).toBe(1);
    const rows = await db.execute(
      sql`SELECT last_error FROM outbox WHERE tenant_id = ${ctx.tenantId} AND kind = 'embed'`,
    );
    const lastError = (rows.rows[0] as { last_error: string }).last_error;
    expect(lastError).toContain("probe: embedding_status ready rejected");
    expect(lastError).toContain("P0001");
    expect(lastError).not.toContain("secret-detail-value-must-not-leak");
  });
});
