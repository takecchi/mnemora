import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { eraseTenant } from "../erase-tenant.js";
import { purgeExpiredEventsForTenant } from "../event-retention-purge.js";
import { runRecall } from "../recall-runtime.js";
import type { RecallRuntimeDeps } from "../recall-runtime.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0430 決定3: 公開の独立関数 `runRecall`・`eraseTenant`・`purgeExpiredEventsForTenant` が
 * 投げる例外も、`Runtime` の各メソッド（ADR 0423 決定6）と同じく、drizzle の
 * `Failed query: <SQL>\nparams: <値>` の `params:` より後ろを落とす。
 *
 * store が drizzle 形の message の例外を投げる fake で縛る（DB は要らない）。
 */

const SECRET = "問いの本文-SECRET-孤立サロゲート\uD800-末尾";
const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

/** drizzle の `DrizzleQueryError` と同じ形の message を持つ例外（cause に pg のエラー）。 */
function drizzleShapedError(): Error {
  return new Error(`Failed query: INSERT INTO recalls (text) VALUES ($1)\nparams: ${SECRET}`, {
    cause: new Error(`Failed query: inner\nparams: ${SECRET}`),
  });
}

function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message, current.stack ?? "");
    current = current.cause;
  }
  return parts.join("\n");
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("reject するはずだった");
}

describe("公開の独立関数が投げる例外に、params（問いの本文）が載らない（ADR 0430）", () => {
  it("runRecall: recalls の記録（createRecall）が失敗しても、message に本文が載らない", async () => {
    const stores = createFakeRuntimeStores();
    stores.memoryStore.createRecall = async () => {
      throw drizzleShapedError();
    };
    const deps: RecallRuntimeDeps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      embeddingProvider: stores.embeddingProvider,
      clock: { now: () => NOW },
      tokenCounter: {
        count: (text: string) => ({ tokens: text.length, counter: "heuristic" as const }),
      },
    };
    const error = await rejectionOf(runRecall(ctx, { text: SECRET, limit: 3 }, deps));
    const text = messagesOf(error);
    expect(text).toContain("Failed query: INSERT INTO recalls");
    expect(text).not.toContain("SECRET");
    expect(text).toMatch(/params: \(omitted by mnemora, \d+ chars\)/);
  });

  it("eraseTenant: store が失敗しても、message に params が載らない", async () => {
    const stores = createFakeRuntimeStores();
    stores.memoryStore.eraseTenant = async () => {
      throw drizzleShapedError();
    };
    const error = await rejectionOf(
      eraseTenant(
        ctx,
        {
          memoryStore: stores.memoryStore,
          vectorStore: stores.vectorStore,
          outboxStore: stores.outboxStore,
          tenantSettingsStore: stores.tenantSettingsStore,
        },
        { confirmTenantId: ctx.tenantId, limit: 3 },
      ),
    );
    expect(messagesOf(error)).not.toContain("SECRET");
  });

  it("purgeExpiredEventsForTenant: store が失敗しても、message に params が載らない", async () => {
    const stores = createFakeRuntimeStores();
    await stores.tenantSettingsStore.setEventRetention(ctx, { kind: "days", days: 30 });
    stores.memoryStore.purgeExpiredEventsByRetention = async () => {
      throw drizzleShapedError();
    };
    const error = await rejectionOf(
      purgeExpiredEventsForTenant(
        ctx,
        { memoryStore: stores.memoryStore, tenantSettingsStore: stores.tenantSettingsStore },
        { limit: 10 },
      ),
    );
    expect(messagesOf(error)).not.toContain("SECRET");
  });

  it("Runtime 経由（二重に掛かる）でも、印の文字数は1回だけ掛けたときと同じ", async () => {
    const stores = createFakeRuntimeStores();
    stores.memoryStore.createRecall = async () => {
      throw drizzleShapedError();
    };
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      lexicalStore: stores.lexicalStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const viaRuntime = await rejectionOf(runtime.recall(ctx, { text: SECRET, limit: 3 }));
    const expectedChars = `${SECRET}`.length;
    expect((viaRuntime as Error).message).toBe(
      `Failed query: INSERT INTO recalls (text) VALUES ($1)\nparams: (omitted by mnemora, ${expectedChars} chars)`,
    );
  });
});
