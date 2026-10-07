import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 戻り値の検査は約束に無い（`resolveEmbeddingInput` は戻り値をそのまま返す）ので、Runtime が先回りして断らないことを縛る。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const LATER = new Date(Date.now() + 60_000);

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(content: string): NewMemory {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: LATER,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: LATER,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

/** 受け取った入力を全部記録し、何が来ても固定のベクトルを返す（受け入れ側の provider）。 */
function tolerantProvider(): EmbeddingProvider & { received: unknown[] } {
  const received: unknown[] = [];
  return {
    space: { provider: "fake", model: "tolerant", dimensions: 2 },
    received,
    embed: async (_ctx, texts) => {
      received.push(...texts);
      return texts.map(() => [1, 0]);
    },
  };
}

async function setup(hook: (memory: Memory) => unknown, provider?: EmbeddingProvider) {
  const stores = createFakeRuntimeStores();
  const calls: Memory[] = [];
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: provider ?? stores.embeddingProvider,
    embeddingInput: ((memory: Memory) => {
      calls.push(memory);
      return hook(memory);
    }) as (memory: Memory) => string,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => LATER },
  });
  const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory("元の本文"), [
    "embed",
  ]);
  return { stores, runtime, calls, memoryId: memory.id };
}

async function statusOf(stores: Awaited<ReturnType<typeof setup>>["stores"], id: string) {
  const memory = await stores.memoryStore.get(ctx, id);
  return { status: memory?.embeddingStatus, content: memory?.content };
}

describe("embeddingInput の戻り値の端（ADR 0489）", () => {
  it("陽性対照: 通常の文字列は provider にそのまま渡り、ready。Memory.content は元のまま", async () => {
    const provider = tolerantProvider();
    const { stores, runtime, memoryId } = await setup(() => "差し替えた入力", provider);
    const result = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(result.processed).toBe(1);
    expect(provider.received).toEqual(["差し替えた入力"]);
    expect(await statusOf(stores, memoryId)).toEqual({ status: "ready", content: "元の本文" });
  });

  it("陽性対照: フックが投げると failed にして再送出（job は failed、lastError に元の例外）", async () => {
    const { stores, runtime, memoryId } = await setup(() => {
      throw new Error("hook exploded");
    });
    const result = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(result.failed).toBe(1);
    expect((await statusOf(stores, memoryId)).status).toBe("failed");
    expect(stores.outboxStore.listJobs(ctx)[0]?.lastError).toContain("hook exploded");
  });

  const STRING_EDGES: ReadonlyArray<readonly [string, string]> = [
    ["空文字", ""],
    ["NUL を含む", "a\u0000b"],
    ["孤立サロゲート", "x\ud800y"],
    ["巨大（20万字）", "あ".repeat(200_000)],
  ];

  it.each(STRING_EDGES)(
    "%s は検査も変換もされず provider にそのまま渡り、受け入れられれば ready",
    async (_label, value) => {
      const provider = tolerantProvider();
      const { stores, runtime, memoryId } = await setup(() => value, provider);
      const result = await runtime.tick(ctx, { leaseMs: 60_000 });
      expect(result.processed).toBe(1);
      expect(provider.received).toEqual([value]);
      expect(await statusOf(stores, memoryId)).toEqual({ status: "ready", content: "元の本文" });
    },
  );

  const NON_STRING: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["数", 42],
    ["オブジェクト", { text: "x" }],
    ["null", null],
  ];

  it.each(NON_STRING)(
    "型の外の値（%s）も検査も変換もされず provider にそのまま渡る",
    async (_label, value) => {
      const provider = tolerantProvider();
      const { runtime } = await setup(() => value, provider);
      await runtime.tick(ctx, { leaseMs: 60_000 });
      expect(provider.received).toHaveLength(1);
      expect(provider.received[0]).toBe(value);
    },
  );

  it.each(NON_STRING)(
    "型の外の値（%s）を fake の provider（text.length を読む）に渡すと failed になり、ready に偽装されない",
    async (_label, value) => {
      const { stores, runtime, memoryId } = await setup(() => value);
      const result = await runtime.tick(ctx, { leaseMs: 60_000 });
      expect(result.failed).toBe(1);
      expect((await statusOf(stores, memoryId)).status).toBe("failed");
    },
  );

  it("reembed() で failed を戻した後の tick で、フックはもう一度呼ばれる（今度は通れば ready）", async () => {
    let attempt = 0;
    const provider = tolerantProvider();
    const { stores, runtime, calls, memoryId } = await setup(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("first attempt fails");
      return "2回目は通る";
    }, provider);
    const first = await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(first.failed).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await statusOf(stores, memoryId)).status).toBe("failed");

    await runtime.reembed(ctx, { statuses: ["failed"], limit: 10 });
    const second = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(second.processed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(provider.received).toEqual(["2回目は通る"]);
    expect((await statusOf(stores, memoryId)).status).toBe("ready");
  });
});
