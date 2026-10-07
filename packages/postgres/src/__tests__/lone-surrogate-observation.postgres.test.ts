import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { createRuntime, isMalformedIdentifierError } from "@mnemora/core";
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

/** 識別子の欄は書く前に断る。本文の欄（`payload`・`attributes`）は列の型によって違う今の振る舞い（`jsonb` は例外）で、`MemoryStore.createObservation` の doc に書いた実態が崩れたら気づくための歯。 */

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

  it("識別子の欄（subjectId・externalId）: 保存の形で区別できないので、書く前に断る（ADR 0423）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    for (const overrides of [{ subjectId: LONE }, { externalId: LONE }]) {
      const error = await store
        .createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: ctx.tenantId, ...overrides }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isMalformedIdentifierError(error)).toBe(true);
    }
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM observations WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    expect(rows[0]?.n).toBe("0");
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
  it("識別子の欄は断り、本文の欄（payload・attributes）は例外を投げず、入力をそのまま保持する", async () => {
    const store = new InMemoryMemoryStore();
    for (const overrides of [{ subjectId: LONE }, { externalId: LONE }]) {
      const error = await store
        .createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: ctx.tenantId, ...overrides }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isMalformedIdentifierError(error)).toBe(true);
    }
    const created = await store.createObservation(
      ctx,
      buildNewObservationFixture({
        tenantId: ctx.tenantId,
        payload: { text: LONE },
        attributes: { note: LONE },
      }),
    );
    const read = await store.getObservation(ctx, created.id);
    expect(read?.payload).toEqual({ text: LONE });
    expect(read?.attributes).toEqual({ note: LONE });
  });
});
