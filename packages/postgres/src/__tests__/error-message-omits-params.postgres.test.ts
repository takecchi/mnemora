import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
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
 * 利用者へ伝わる例外の message から、SQL に付けた値（params）を落とす（ADR 0423。ADR 0363 と同じ作法）。
 *
 * 本物の drizzle が包んだ例外（`Failed query: <SQL>\nparams: <値>`）で見る。本文に値を入れた入力で
 * 例外を起こし、message に本文が入らないこと、SQL の文・`cause` の理由と SQLSTATE が残ることを確かめる。
 * 例外の起こし方は、jsonb 列が受けない値（孤立サロゲート）を本文に入れること——本文そのものの扱いは変えない。
 */

const ctx: Ctx = { tenantId: "error-message-omits-params" };
const BODY_MARKER = "本文の目印-0123456789";
const BAD_BODY = `${BODY_MARKER}\uD83D`;

afterAll(async () => {
  await closeTestClient();
});

async function buildRuntime() {
  const { db } = await getTestClient();
  return createRuntime({
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
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("reject しなかった");
}

describe("runtime.observe の例外の message に、本文は入らない", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("SQL の文と cause（pg の理由と SQLSTATE）は残り、params の値は message にも stack にも無い", async () => {
    const runtime = await buildRuntime();
    const error = await thrown(runtime.observe(ctx, { kind: "utterance", text: BAD_BODY }));

    expect(error.message).toContain("Failed query:");
    expect(error.message).toContain("observations");
    expect(error.message).not.toContain(BODY_MARKER);
    expect(String(error.stack)).not.toContain(BODY_MARKER);
    const cause = error.cause as { message?: string; code?: string } | undefined;
    expect(cause?.code).toBe("22P02");
    expect(cause?.message).toMatch(/invalid input syntax for type json/);
  });
});
