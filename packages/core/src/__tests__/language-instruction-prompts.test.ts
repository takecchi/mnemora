import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { buildExtractionPrompt } from "../extraction.js";
import type { LLMProvider, PromptSpec, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import type { Observation } from "../observation.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { buildConsolidationPrompt } from "../strategies/consolidate.js";
import { buildReflectionPrompt } from "../strategies/reflect.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const LANGUAGE_SENTENCE =
  "記憶の本文（content）と要旨（digest）は、観測の本文と同じ言語で書いてください";
const CONSOLIDATE_LANGUAGE_SENTENCE =
  "統合した本文と要旨は、渡された記憶と同じ言語で書いてください。";
const REFLECT_LANGUAGE_SENTENCE =
  "新しい記憶の本文と要旨は、渡された記憶と同じ言語で書いてください。";

function newMemory(content: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${content}`,
    digest: `digest-${content}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

function observation(payload: Record<string, unknown>): Observation {
  return {
    id: "obs-1",
    tenantId: "tenant-1",
    subjectId: "user-1",
    externalId: null,
    kind: "utterance",
    payload,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    recordedAt: new Date("2026-01-01T00:00:01.000Z"),
  };
}

function memoriesOf(count: number): Memory[] {
  return Array.from({ length: count }, (_, i) => ({
    ...newMemory(`本文${i}`),
    id: `m-${i}`,
    createdAt: NOW,
    updatedAt: NOW,
    status: "active",
  })) as unknown as Memory[];
}

describe("抽出の言語の指示は、subjectCandidates を渡した呼び出しに extractionContext の有無を問わず足される", () => {
  it("extractionContext も一緒に渡したときも、出力言語の指示が system に入る", () => {
    const prompt = buildExtractionPrompt(
      observation({
        text: "明日は東京に出張する予定です",
        speaker: "田中",
        extractionContext: { messages: [{ speaker: "assistant", text: "了解です" }] },
      }),
      ["user:a"],
    );
    expect(prompt.system).toContain(LANGUAGE_SENTENCE);
  });

  it("extractionContext を渡さないときも、出力言語の指示が system に入る", () => {
    const prompt = buildExtractionPrompt(observation({ text: "明日は東京に出張する予定です" }), [
      "user:a",
    ]);
    expect(prompt.system).toContain(LANGUAGE_SENTENCE);
  });
});

describe("統合・内省の言語の指示は、記憶の件数によらず system に入る", () => {
  it.each([1, 2, 3])("統合: 記憶が %i 件", (count) => {
    expect(buildConsolidationPrompt(memoriesOf(count)).system).toContain(
      CONSOLIDATE_LANGUAGE_SENTENCE,
    );
  });

  it.each([1, 2, 3])("内省: 記憶が %i 件", (count) => {
    expect(buildReflectionPrompt(memoriesOf(count)).system).toContain(REFLECT_LANGUAGE_SENTENCE);
  });
});

describe("Runtime が LLM へ渡す統合・内省の system", () => {
  function recordingLlm(received: PromptSpec[]): LLMProvider {
    return {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        received.push(req.prompt);
        const consolidated = req.schema.safeParse({ content: "統合後" });
        return (
          consolidated.success ? consolidated.data : req.schema.parse({ outcome: "nothing" })
        ) as T;
      },
    };
  }

  async function runtimeWith(received: PromptSpec[]) {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: recordingLlm(received),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
    return { runtime, ids: [a.id, b.id] };
  }

  it("consolidate は、同じ言語で書く指示を含む system を LLM へ渡す", async () => {
    const received: PromptSpec[] = [];
    const { runtime, ids } = await runtimeWith(received);
    await runtime.consolidate(ctx, { target: { memoryIds: ids } });
    expect(received).toHaveLength(1);
    expect(received[0]?.system).toContain(CONSOLIDATE_LANGUAGE_SENTENCE);
  });

  it("reflect は、同じ言語で書く指示を含む system を LLM へ渡す", async () => {
    const received: PromptSpec[] = [];
    const { runtime, ids } = await runtimeWith(received);
    await runtime.reflect(ctx, { target: { memoryIds: ids } });
    expect(received).toHaveLength(1);
    expect(received[0]?.system).toContain(REFLECT_LANGUAGE_SENTENCE);
  });
});
