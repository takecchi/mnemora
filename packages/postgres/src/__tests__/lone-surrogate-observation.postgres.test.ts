import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
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
 * 孤立サロゲート（対をなさない UTF-16 サロゲートコードユニット）を含む Observation の書き込みが、
 * adapter と列の型によって違うことを、今の振る舞いのまま縛る（Issue #1075）。
 *
 * どれに揃えるか（正規化・拒否・このまま）は決めていない。この歯は約束を足すものではなく、
 * `MemoryStore.createObservation` の doc コメントに書いた実態が崩れたら気づくためのもの。
 * Memory の側（`createMemory`）は同じ doc の `createMemory` の節（PR #1078）。
 */

const ctx: Ctx = { tenantId: "lone-surrogate-observation" };
/** `text.slice(0, n)` がサロゲートペアの間を切ったときにできる形（😀 の上位半分だけ）。 */
const LONE = "途中で切れた\uD83D";

afterAll(async () => {
  await closeTestClient();
});

/** drizzle は pg の例外を `cause` に包むので、両方の文面を見る。 */
async function rejectsWithJsonSyntaxError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const cause = (error as { cause?: unknown }).cause;
  const messages = [(error as Error).message, cause instanceof Error ? cause.message : ""];
  expect(messages.join("\n")).toMatch(/invalid input syntax for type json/);
}

describe("PostgresMemoryStore.createObservation — 孤立サロゲート", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("jsonb 列（payload）: 例外を投げる", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await rejectsWithJsonSyntaxError(
      store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, payload: { text: LONE } }),
      ),
    );
  });

  it("jsonb 列（attributes）: 例外を投げる", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await rejectsWithJsonSyntaxError(
      store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, attributes: { note: LONE } }),
      ),
    );
  });

  it("text 列（subjectId・externalId）: 例外を投げず、U+FFFD に置き換えて保存する", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const created = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId, subjectId: LONE, externalId: LONE }),
    );
    const read = await store.getObservation(ctx, created.id);
    expect(read?.subjectId).toBe("途中で切れた�");
    expect(read?.externalId).toBe("途中で切れた�");
  });

  it("runtime.observe({ text }) は Observation を書く前に例外になる", async () => {
    const { db, pool } = await getTestClient();
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async () => {
          throw new Error("not reached");
        },
      },
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    });
    await rejectsWithJsonSyntaxError(runtime.observe(ctx, { kind: "utterance", text: LONE }));
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM observations WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    expect(rows[0]?.n).toBe("0");
  });
});

describe("testkit の InMemoryMemoryStore.createObservation — 孤立サロゲート", () => {
  it("どの欄でも例外を投げず、入力をそのまま保持する", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.createObservation(
      ctx,
      buildNewObservationFixture({
        tenantId: ctx.tenantId,
        subjectId: LONE,
        externalId: LONE,
        payload: { text: LONE },
        attributes: { note: LONE },
      }),
    );
    const read = await store.getObservation(ctx, created.id);
    expect(read?.subjectId).toBe(LONE);
    expect(read?.externalId).toBe(LONE);
    expect(read?.payload).toEqual({ text: LONE });
    expect(read?.attributes).toEqual({ note: LONE });
  });
});
