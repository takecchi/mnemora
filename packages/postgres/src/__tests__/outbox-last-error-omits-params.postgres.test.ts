import { createHash, randomUUID } from "node:crypto";
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
 * DB への書き込みが失敗したとき、drizzle が包んだエラー文（`Failed query: <SQL>\nparams: <値>`）の `params:` 以降（失敗したクエリに渡した値そのもの。Memory の本文などの利用者データ）は、`describeJobFailure` が `(omitted by mnemora, N chars)` という印に置き換える。
 * SQL の文そのものと、cause の連鎖（pg の生エラー・SQLSTATE）は残る。
 *
 * 書き込みを失敗させるのには、抽出結果の tag に圧縮の効かない1万字の値を入れる（GIN 索引 `idx_memories_tags` の行の上限を超えて INSERT が `54000` で落ちる。claim key が無いので `ClaimKeyIndexLimitError` には包まれない）。
 * 本文は合成したもの（目印の uuid を含む）。本文の NUL では `PostgresMemoryStore` が DB に触れる前に名指しの例外で断るので DB の失敗にならず、落とし方を差し替えてある。params に本文が載るのは、どの値で落ちても INSERT の全値が params に入るからである。
 */

/** 圧縮が効かない長い hex。⚠ `"ab".repeat(n)` のような繰り返しは圧縮されて通る（実測、claim-key-index-limit-error の歯と同じ）。 */
function incompressibleHex(seed: string, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  }
  return out.slice(0, length);
}

const ctx: Ctx = { tenantId: `outbox-last-error-body-${randomUUID()}` };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

describe("OutboxJob.lastError は、失敗したクエリの params（利用者の本文）を落とす（Issue #1064、ADR 0363）", () => {
  it("extract ジョブの書き込みが失敗しても、lastError に合成の本文は載らず、SQL の形と印だけが残る", async () => {
    const { db, pool } = await getTestClient();
    const marker = `合成の本文の目印-${randomUUID()}`;
    const body = `${marker} ${"あ".repeat(2000)}末尾`;
    const llmProvider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async (_ctx, req) =>
        req.schema.parse({
          memories: [
            { content: body, provenanceKind: "stated", tags: [incompressibleHex("g", 10000)] },
          ],
        }),
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
      hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    });

    await runtime.observe(ctx, { kind: "utterance", text: "元の発話", extract: "deferred" });
    const result = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 1 });
    expect(result.failed).toBe(1);

    const row = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM outbox WHERE tenant_id = $1 AND kind = 'extract'`,
      [ctx.tenantId],
    );
    const lastError = row.rows[0]?.last_error ?? "";

    expect(lastError).toContain("Failed query");
    expect(lastError).toContain("params: (omitted by mnemora,");
    expect(lastError).toMatch(/params: \(omitted by mnemora, \d+ chars\)/);
    expect(lastError).toContain("(code: 54000)");

    expect(lastError).not.toContain(marker);
    expect(lastError).not.toContain("あ".repeat(50));
    expect(lastError).not.toContain("末尾");

    expect(lastError.length).toBeLessThan(body.length);
    expect(lastError.length).toBeLessThan(3000);
  });
});
