import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// ここでは DB を使わず、drizzle が包んだ形の例外を fake の store に投げさせる
// （本物の drizzle/pg での形は `packages/postgres` の outbox の歯が見ている）。

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LATER = new Date(Date.now() + 60_000);

const PARAM_VALUE = "利用者の本文-params-に付いた値";

/** drizzle の `DrizzleQueryError` と同じ形: 外側は `Failed query`＋params、理由と SQLSTATE は cause。 */
function drizzleWrapped(): Error {
  const pgError = Object.assign(new Error("permission denied for table memories"), {
    code: "42501",
  });
  return new Error(`Failed query: UPDATE memories SET status = $1\nparams: ${PARAM_VALUE}`, {
    cause: pgError,
  });
}

const EXPECTED =
  "Failed query: UPDATE memories SET status = $1\n" +
  `params: (omitted by mnemora, ${PARAM_VALUE.length} chars)` +
  " <- caused by: permission denied for table memories (code: 42501)";

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = NOW;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime(now: Date = NOW) {
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
    clock: { now: () => now },
  });
  return { runtime, stores };
}

describe("outcome の error は outbox の last_error と同じ整形（ADR 0363、2026-09-30 追記）", () => {
  it("forget: failed の error に params の値は載らず、cause の理由と SQLSTATE が載る", async () => {
    const { runtime, stores } = buildRuntime();
    stores.memoryStore.getMany = async () => {
      throw drizzleWrapped();
    };

    const result = await runtime.forget(ctx, { memoryId: "m-1" });

    expect(result.outcomes).toEqual([{ memoryId: "m-1", kind: "failed", error: EXPECTED }]);
    expect(JSON.stringify(result)).not.toContain(PARAM_VALUE);
  });

  it("purge: failed の error も同じ整形", async () => {
    const { runtime, stores } = buildRuntime();
    stores.memoryStore.getMany = async () => {
      throw drizzleWrapped();
    };

    const result = await runtime.purge(ctx, { memoryId: "m-1" });

    expect(result.outcomes).toEqual([{ memoryId: "m-1", kind: "failed", error: EXPECTED }]);
  });

  it("restoreArchived: failed の error と reinforceError が同じ整形", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    stores.memoryStore.reinforce = async () => {
      throw drizzleWrapped();
    };
    const reinforceFailed = await runtime.restoreArchived(ctx, { memoryId: memory.id });
    expect(reinforceFailed.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "restored",
        previousStatus: "archived",
        reinforceError: EXPECTED,
      },
    ]);

    stores.memoryStore.getMany = async () => {
      throw drizzleWrapped();
    };
    const readFailed = await runtime.restoreArchived(ctx, { memoryId: memory.id });
    expect(readFailed.outcomes).toEqual([{ memoryId: memory.id, kind: "failed", error: EXPECTED }]);
  });

  it("restoreSuperseded: reinforceError が同じ整形", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory({ content: "anchor" }));
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "source", status: "superseded", supersededById: anchor.id }),
    );
    stores.memoryStore.reinforce = async () => {
      throw drizzleWrapped();
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });

    expect(result.outcomes).toMatchObject([
      { memoryId: source.id, kind: "restored", reinforceError: EXPECTED },
    ]);
  });

  it("purge: embeddingCleanup.error も同じ整形（purged）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw drizzleWrapped();
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "purged",
        previousStatus: "forgotten",
        embeddingCleanup: { status: "failed", error: EXPECTED },
      },
    ]);
  });

  it("tick の lastError と同じ出力になる（同じ例外を投げたとき、1文字も違わない）", async () => {
    const { runtime, stores } = buildRuntime(LATER);
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    stores.embeddingProvider.embed = async () => {
      throw drizzleWrapped();
    };
    const tick = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(tick.failed).toBe(1);

    expect(stores.outboxStore.listJobs(ctx)[0]?.lastError).toBe(EXPECTED);
  });
});

describe("runtime.purge — 競合後の再読で already_purged になる枝の後始末（ADR 0399 の 2026-09-30 追記）", () => {
  it("deleteAcrossSpaces が失敗したら、kind は already_purged のまま embeddingCleanup が付く", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
        live.purgedAt = new Date();
        live.content = "[purged]";
        live.digest = "[purged]";
      }
    };
    stores.vectorStore.deleteAcrossSpaces = async () => {
      throw drizzleWrapped();
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      {
        memoryId: memory.id,
        kind: "already_purged",
        embeddingCleanup: { status: "failed", error: EXPECTED },
      },
    ]);
  });

  it("成功したときは embeddingCleanup というプロパティ自体が無い", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        // `createMemory` の返り値は写し。store の中の行を書き換える。
        const live = stores.memoryStore.liveRowForTest(ctx, memory.id)!;
        live.purgedAt = new Date();
        live.content = "[purged]";
        live.digest = "[purged]";
      }
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
  });
});
