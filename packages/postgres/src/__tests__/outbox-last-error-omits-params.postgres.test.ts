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
 * 書き込みを失敗させるのには、`outbox-fail-nul-last-error.postgres.test.ts` と同じく、
 * 抽出結果の本文に NUL を入れる（Postgres の `text` は NUL を保存できない）。本文は
 * 合成したもの（目印の uuid を含む）で、実データではない。
 *
 * `hashContent` は本文の sha256 の16進（NUL を含まない）にしてある。`contentHash` に NUL が
 * 入ると、`PostgresMemoryStore` が DB に触れる前に明示の例外で断る（ADR 0424 の O-6）ため、
 * DB の失敗（drizzle の `Failed query` と `params:`）が起きない。本文の NUL は入口で断られず、
 * DB の INSERT まで届いて `22021` で落ちる。
 */

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
    // pg 側の cause（invalid byte sequence、NUL が原因）の SQLSTATE は残る。
    expect(lastError).toContain("(code: 22021)");

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
