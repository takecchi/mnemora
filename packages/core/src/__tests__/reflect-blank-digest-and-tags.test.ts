import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { ReflectionLLMResultSchema } from "../strategies/reflect.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `ReflectionLLMResultSchema` の `digest`・`tags` を、TSDoc と抽出・consolidate の schema に揃えた歯。
 *
 * - `digest: ""`: TSDoc は「省略・空文字は機械的な先頭文字列切り出しへフォールバックする（`resolveDigest`）」と
 *   書いていたが、schema が `min(1)` で応答ごと拒み、`reflect()` は `llm_failed` になっていた。
 * - `tags: [""]`: 実装は `dropBlankTags` で空の tag を落とす前提だが、schema が `min(1)` で応答ごと拒んでいた
 *   （抽出・consolidate の schema は空文字の tag を受け付ける）。
 *
 * やりすぎを捕まえる歯: 型の違う値（`digest: 123`・`tags: [1]`）と空の `content` は今どおり拒む。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: ["from-basis"],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function llmReturning(result: Record<string, unknown>): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(result) as T,
  };
}

async function reflectWith(
  result: Record<string, unknown>,
  config?: { digestFallbackLength?: number },
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llmReturning(result),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    ...(config === undefined ? {} : { config }),
  });
  const basis = await stores.memoryStore.createMemory(ctx, newMemory());
  const reflected = await runtime.reflect(ctx, { target: { memoryIds: [basis.id] } });
  const memory =
    reflected.reflectedMemoryId === null
      ? null
      : await stores.memoryStore.get(ctx, reflected.reflectedMemoryId);
  return { reflected, memory };
}

describe("runtime.reflect — LLM の digest が空文字なら機械的な切り出しへフォールバックする", () => {
  it("digest: '' でも reflected になり、digestSource は fallback、digest は content の先頭", async () => {
    const { reflected, memory } = await reflectWith({
      outcome: "reflected",
      content: "内省で得た気づきの本文",
      digest: "",
    });

    expect({
      outcome: reflected.outcome,
      llmFailure: reflected.llmFailure,
      digestSource: memory?.digestSource,
      digest: memory?.digest,
    }).toEqual({
      outcome: "reflected",
      llmFailure: null,
      digestSource: "fallback",
      digest: "内省で得た気づきの本文",
    });
  });
});

describe("フォールバックの digest は config.digestFallbackLength に従う（reflect・consolidate）", () => {
  const longContent = "あ".repeat(30) + "い".repeat(300);

  it("reflect: 空文字の digest のフォールバックは、config の長さで切って … を付ける", async () => {
    const { memory } = await reflectWith(
      { outcome: "reflected", content: longContent, digest: "" },
      { digestFallbackLength: 7 },
    );

    expect([memory?.digestSource, memory?.digest]).toEqual(["fallback", "あ".repeat(7) + "…"]);
  });

  it("reflect: config を渡さなければ、既定の200字で切る", async () => {
    const { memory } = await reflectWith({
      outcome: "reflected",
      content: longContent,
      digest: "",
    });

    expect([memory?.digestSource, memory?.digest]).toEqual([
      "fallback",
      "あ".repeat(30) + "い".repeat(170) + "…",
    ]);
  });

  async function consolidateWith(config?: { digestFallbackLength?: number }) {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning({ content: longContent }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
      ...(config === undefined ? {} : { config }),
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.outcome).toBe("consolidated");
    return stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
  }

  it("consolidate: digest を省いた応答のフォールバックは、config の長さで切って … を付ける", async () => {
    const memory = await consolidateWith({ digestFallbackLength: 7 });

    expect([memory?.digestSource, memory?.digest]).toEqual(["fallback", "あ".repeat(7) + "…"]);
  });

  it("consolidate: config を渡さなければ、既定の200字で切る", async () => {
    const memory = await consolidateWith();

    expect([memory?.digestSource, memory?.digest]).toEqual([
      "fallback",
      "あ".repeat(30) + "い".repeat(170) + "…",
    ]);
  });
});

describe("runtime.reflect — LLM の tags に空文字があっても、その tag だけを落とす", () => {
  it("tags: ['', '  ', 'kept'] は reflected になり、Memory の tags は ['kept']", async () => {
    const { reflected, memory } = await reflectWith({
      outcome: "reflected",
      content: "気づき",
      digest: "要旨",
      tags: ["", "  ", "kept"],
    });

    expect({ outcome: reflected.outcome, tags: memory?.tags }).toEqual({
      outcome: "reflected",
      tags: ["kept"],
    });
  });
});

describe("ReflectionLLMResultSchema — やりすぎない: 型の違う値と空の content は今どおり拒む", () => {
  it.each([
    ["digest が数値", { outcome: "reflected", content: "x", digest: 123 }],
    ["tags の要素が数値", { outcome: "reflected", content: "x", tags: [1] }],
    ["content が空文字", { outcome: "reflected", content: "" }],
    ["content が無い", { outcome: "reflected" }],
  ])("%s は拒む", (_label, value) => {
    expect(ReflectionLLMResultSchema.safeParse(value).success).toBe(false);
  });

  it("digest・tags を省いた応答と outcome: 'nothing' は今どおり受け付ける", () => {
    expect([
      ReflectionLLMResultSchema.safeParse({ outcome: "reflected", content: "x" }).success,
      ReflectionLLMResultSchema.safeParse({ outcome: "nothing" }).success,
    ]).toEqual([true, true]);
  });
});
