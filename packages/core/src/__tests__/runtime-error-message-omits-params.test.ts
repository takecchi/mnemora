import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// DB を使わず、drizzle の `DrizzleQueryError` と同じ形（message が `Failed query: <SQL>\nparams: <値>`）の例外を
// fake の store に投げさせる（本物の drizzle での形は `packages/postgres` の歯が見ている）。

const SECRET = "利用者の本文-SECRET-0123";

class QueryFailure extends Error {
  readonly kind = "store_failure";
  constructor(cause: Error) {
    super(`Failed query: INSERT INTO observations (payload) VALUES ($1)\nparams: ${SECRET}`, {
      cause,
    });
  }
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

const ctx: Ctx = { tenantId: "t" };

async function thrown(promise: Promise<unknown>): Promise<Error & { kind?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("reject しなかった");
}

describe("runtime が投げ直す例外の message に、入力値は入らない", () => {
  it("observe: message から params の値を落とし、SQL の文・kind・cause は残す", async () => {
    const { runtime, stores } = buildRuntime();
    const pgError = Object.assign(new Error("permission denied for table observations"), {
      code: "42501",
    });
    const original = new QueryFailure(pgError);
    stores.memoryStore.createObservationWithOutbox = async () => {
      throw original;
    };

    const error = await thrown(runtime.observe(ctx, { kind: "utterance", text: SECRET }));

    expect(error.message).not.toContain(SECRET);
    expect(String(error.stack)).not.toContain(SECRET);
    expect(error.message).toContain("Failed query: INSERT INTO observations (payload) VALUES ($1)");
    expect(error.kind).toBe("store_failure");
    expect(error.cause).toBe(pgError);
    expect(error).toBe(original);
  });

  it("recall: 同じく落とす", async () => {
    const { runtime, stores } = buildRuntime();
    stores.memoryStore.aggregateScope = async () => {
      throw new QueryFailure(new Error("boom"));
    };

    const error = await thrown(runtime.recall(ctx, { text: SECRET }));

    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("Failed query:");
    expect(error.kind).toBe("store_failure");
  });

  it("params: を含まない message は変えない", async () => {
    const { runtime, stores } = buildRuntime();
    stores.memoryStore.createObservationWithOutbox = async () => {
      throw new Error("plain failure");
    };
    const error = await thrown(runtime.observe(ctx, { kind: "utterance", text: "本文" }));
    expect(error.message).toBe("plain failure");
  });
});
