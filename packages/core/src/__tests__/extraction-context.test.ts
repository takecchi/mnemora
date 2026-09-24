import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import { ObserveInputSchema } from "../observation.js";
import type { PromptSpec, LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import recording from "./fixtures/extraction-context-recorded.json";

const ctx = { tenantId: "context-test" };
const extractionContext = {
  messages: [{ speaker: "assistant", text: "会議室は青葉でよいですか？" }],
  timeZone: "Asia/Tokyo",
};
describe("extraction context transport (not a semantic quality test)", () => {
  for (const extract of ["sync", "deferred"] as const) {
    it(`${extract} and reextract retain context and original observation metadata`, async () => {
      const prompts: PromptSpec[] = [];
      const llmProvider: LLMProvider = {
        complete: async () => {
          throw new Error("unused");
        },
        completeStructured: async (_ctx, req) => {
          prompts.push(req.prompt);
          return req.schema.parse({
            memories: [{ content: "会議室は青葉", provenanceKind: "stated" }],
          });
        },
      };
      const stores = createFakeRuntimeStores();
      const runtime = createRuntime({ ...stores, llmProvider, hashContent: (s) => s });
      const observed = await runtime.observe(ctx, {
        kind: "utterance",
        text: "それでお願いします",
        speaker: "田中",
        subjectId: "tanaka",
        occurredAt: new Date("2026-01-01T23:00:00Z"),
        extract,
        extractionContext,
      });
      if (extract === "deferred") await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60000 });
      const saved = await stores.memoryStore.getObservation(ctx, observed.observationId);
      expect(saved?.payload).toMatchObject({ text: "それでお願いします", extractionContext });
      await runtime.reextract(ctx, observed.observationId);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toEqual(prompts[0]);
      expect(JSON.parse(prompts[0]!.messages[0]!.content)).toMatchObject({
        observation: {
          text: "それでお願いします",
          speaker: "田中",
          subjectId: "tanaka",
          occurredAt: "2026-01-01T23:00:00.000Z",
        },
        context: extractionContext.messages,
        timeZone: "Asia/Tokyo",
      });
    });
  }
  it("rejects excessive context and invalid time zones before ingestion", () => {
    for (const context of [
      { messages: Array(9).fill({ text: "a" }) },
      { messages: [{ text: "a".repeat(2001) }] },
      { timeZone: "not/a-zone" },
    ]) {
      expect(
        ObserveInputSchema.safeParse({ kind: "utterance", text: "ok", extractionContext: context })
          .success,
      ).toBe(false);
    }
  });
  it("does not silently substitute recordedAt for unknown occurredAt", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      kind: "utterance",
      recordedAt: new Date("2026-01-01Z"),
      payload: { text: "明日", extractionContext: {} },
    });
    expect(JSON.parse(prompt.messages[0]!.content).observation.occurredAt).toBeNull();
  });
});

describe("recorded development cases: prompt identity and retained answer information", () => {
  for (const row of recording.rows.filter((r) => r.enabled)) {
    it(row.id, () => {
      expect(
        buildExtractionPrompt({
          ...row.observation,
          occurredAt: new Date(row.observation.occurredAt),
          recordedAt: new Date(row.observation.recordedAt),
        }),
      ).toEqual(row.prompt);
      const memories = JSON.parse(row.response.message.content!).memories as {
        content: string;
        digest: string | null;
      }[];
      const digests = memories.map((m) => m.digest ?? m.content).join("\n");
      if (row.id === "reference") expect(digests).toContain("青葉");
      if (row.id === "relative-date") expect(digests).toMatch(/2026(?:年|-)0?1(?:月|-)0?3/);
      if (row.id === "other-speaker") {
        expect(digests).toContain("紅茶");
        expect(digests).not.toContain("コーヒー");
      }
    });
  }
});
