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
 * `OutboxJob.lastError` の TSDoc（`packages/core/src/outbox.ts`、Issue #1064、
 * [ADR 0363](../../../docs/decisions/0363-outbox-last-error-omit-params-and-cap-length.md)）:
 * `@mnemora/postgres` で DB への書き込みが失敗したとき、drizzle が包んだエラー文
 * （`Failed query: <SQL>\nparams: <値>`）の `params:` 以降（失敗したクエリに渡した値
 * そのもの——Memory の本文などの利用者データ）は、`describeJobFailure`
 * （`@mnemora/core` の `runtime.ts`）が `(omitted by mnemora, N chars)` という印に
 * 置き換える。SQL の文そのもの（テーブル名・列名・クエリの形）と、cause の連鎖
 * （pg の生エラー・SQLSTATE）は今までどおり残る。
 *
 * これは元々 `outbox-last-error-carries-body.postgres.test.ts` という名で「削らずに
 * 含む」今の振る舞いを縛っていた歯を、ADR 0363 の決定に合わせて書き換えたもの
 * （ファイル名も変更）。
 *
 * 書き込みを失敗させるのには、抽出結果の tag に圧縮の効かない1万字の値を入れる
 * （GIN 索引 `idx_memories_tags` の行の上限を超えて INSERT が `54000` で落ちる。
 * claim key が無いので `ClaimKeyIndexLimitError` には包まれない——ADR 0435・0443 決定1）。
 * 本文は合成したもの（目印の uuid を含む）で、実データではない。
 *
 * ⚠ 2026-10-02 までは本文に NUL を入れて `22021` で落としていた。ADR 0499 で
 * `PostgresMemoryStore` が本文の NUL を DB に触れる前に名指しの例外で断るようになり、
 * DB の失敗（drizzle の `Failed query` と `params:`）が起きなくなったため、落とし方を差し替えた。
 * params に本文が載るのは、どの値で落ちても INSERT の全値が params に入るからである。
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

    // SQL の形（drizzle の "Failed query" の文面）は残る。
    expect(lastError).toContain("Failed query");
    // params の中身は「印」に置き換わり、値そのものはもう無い。
    expect(lastError).toContain("params: (omitted by mnemora,");
    expect(lastError).toMatch(/params: \(omitted by mnemora, \d+ chars\)/);
    // pg 側の cause（index row size、長い tag が原因）の SQLSTATE は残る。
    expect(lastError).toContain("(code: 54000)");

    // 合成の本文の目印・繰り返し文字は、もうどこにも無い。
    expect(lastError).not.toContain(marker);
    expect(lastError).not.toContain("あ".repeat(50));
    expect(lastError).not.toContain("末尾");

    // params を落としたことで、元の本文よりずっと短くなる。
    expect(lastError.length).toBeLessThan(body.length);
    // SQL の文＋cause の連鎖だけになった結果は、上限（4096）よりだいぶ小さい範囲に収まる
    // （このシナリオでは上限そのものには当たらない——上限が効くケースは
    // `tick-last-error-redacts-params.test.ts`（fixture、core 側）で別に測っている）。
    expect(lastError.length).toBeLessThan(3000);
  });
});
