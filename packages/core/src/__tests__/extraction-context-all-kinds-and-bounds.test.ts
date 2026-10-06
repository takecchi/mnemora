import { describe, expect, it } from "vitest";
import { ObserveInputSchema } from "../observation.js";
import type { PromptSpec, LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `extractionContext`（ADR 0299、PR #694）の約束のうち、`extraction-context.test.ts` が
 * `kind: "utterance"` と「超えたら断る」側しか見ていなかった穴を塞ぐ（Issue #1776 の #694 の
 * コメント、ADR 0665）。
 *
 * - 文脈は `utterance`・`event`・`document` の3種とも、観測の payload に保存され、抽出のプロンプトに渡る。
 * - 上限（messages 8件・text 2000字・speaker 200字）は「ちょうどは通る」。黙って切り捨てない。
 */

const ctx = { tenantId: "context-all-kinds" };

const OBSERVATIONS = {
  utterance: { kind: "utterance", text: "それでお願いします", speaker: "田中" },
  event: { kind: "event", name: "meeting-confirmed", data: { room: "青葉" } },
  document: { kind: "document", title: "議事録", content: "会議室は青葉に決まった。" },
} as const;

function recordingRuntime() {
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
  return { prompts, stores, runtime };
}

describe("extractionContext は3種の観測すべてで、保存され、プロンプトに渡る（#694）", () => {
  const extractionContext = {
    messages: [{ speaker: "assistant", text: "会議室は青葉でよいですか？" }, { text: "はい" }],
    timeZone: "Asia/Tokyo",
  };

  it.each(["utterance", "event", "document"] as const)(
    "%s: payload.extractionContext に保存され、プロンプト JSON の context・timeZone に入り、reextract でも同じ",
    async (kind) => {
      const { prompts, stores, runtime } = recordingRuntime();
      const observed = await runtime.observe(ctx, {
        ...OBSERVATIONS[kind],
        occurredAt: new Date("2026-01-01T23:00:00Z"),
        extractionContext,
      });
      const saved = await stores.memoryStore.getObservation(ctx, observed.observationId);
      expect(saved?.payload).toMatchObject({ extractionContext });

      expect(prompts).toHaveLength(1);
      const sent = JSON.parse(prompts[0]!.messages[0]!.content);
      expect(sent.context).toEqual(extractionContext.messages);
      expect(sent.timeZone).toBe("Asia/Tokyo");

      await runtime.reextract(ctx, observed.observationId);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toEqual(prompts[0]);
    },
  );

  it.each(["utterance", "event", "document"] as const)(
    "%s: extractionContext を渡さなければ payload にキーが無く、プロンプトに context も timeZone も出ない",
    async (kind) => {
      const { prompts, stores, runtime } = recordingRuntime();
      const observed = await runtime.observe(ctx, { ...OBSERVATIONS[kind] });
      const saved = await stores.memoryStore.getObservation(ctx, observed.observationId);
      expect(saved?.payload as object).not.toHaveProperty("extractionContext");
      expect(prompts[0]!.messages[0]!.content).not.toContain('"context"');
      expect(prompts[0]!.messages[0]!.content).not.toContain("timeZone");
    },
  );
});

describe("extractionContext の上限は、ちょうどの値が通り、プロンプトでも切り捨てられない（#694）", () => {
  const parse = (extractionContext: unknown) =>
    ObserveInputSchema.safeParse({ kind: "utterance", text: "ok", extractionContext });

  it("messages は8件ちょうどが通り、9件は断る", () => {
    expect(parse({ messages: Array(8).fill({ text: "a" }) }).success).toBe(true);
    expect(parse({ messages: Array(9).fill({ text: "a" }) }).success).toBe(false);
  });

  it("text は2000字ちょうどが通り、2001字は断る", () => {
    expect(parse({ messages: [{ text: "a".repeat(2000) }] }).success).toBe(true);
    expect(parse({ messages: [{ text: "a".repeat(2001) }] }).success).toBe(false);
  });

  it("speaker は200字ちょうどが通り、201字は断る", () => {
    expect(parse({ messages: [{ speaker: "s".repeat(200), text: "a" }] }).success).toBe(true);
    expect(parse({ messages: [{ speaker: "s".repeat(201), text: "a" }] }).success).toBe(false);
  });

  it("8件・各2000字・speaker 200字の文脈は、プロンプトの context に1件も欠けず・切れずに入る", async () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      speaker: `${i}`.repeat(200),
      text: `${i}`.repeat(2000),
    }));
    const { prompts, runtime } = recordingRuntime();
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "それでお願いします",
      speaker: "田中",
      extractionContext: { messages },
    });
    const sent = JSON.parse(prompts[0]!.messages[0]!.content);
    expect(sent.context).toEqual(messages);
  });
});
