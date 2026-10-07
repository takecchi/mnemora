import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, buildNewMemoryFromCandidate } from "../extraction.js";
import { ObserveInputSchema } from "../observation.js";
import type { Observation } from "../observation.js";
import type { ObservationId } from "../ids.js";
import type { PromptSpec, LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import recording from "./fixtures/extraction-context-recorded.json" with { type: "json" };

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
  // `timeZone` の検査が問うのは「`Intl.DateTimeFormat` が受け付けるか」だけで、IANA の名前に絞っていない。
  // 値は正規化せず、渡された文字列のまま保存され、プロンプトにもそのまま入る（`ExtractionContextSchema` の doc）。
  // 検査を IANA の名前だけに絞る・正規化して保存する、のどちらも、今は通る入力の結果が変わる（破壊的）。
  // 受け付ける値の集合は実行環境の `Intl` に依存するので、ここで縛るのは Node の既定の ICU で通る3つだけ。
  it.each(["JST", "+09:00", "asia/tokyo"])(
    "timeZone %j は受け付け、渡された綴りのまま保存され、プロンプトにもそのまま入り、暦日はその値で計算される",
    async (timeZone) => {
      expect(
        ObserveInputSchema.safeParse({
          kind: "utterance",
          text: "ok",
          extractionContext: { timeZone },
        }).success,
      ).toBe(true);

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
        text: "明日は会議室",
        occurredAt: new Date("2026-01-01T23:00:00Z"),
        extract: "sync",
        extractionContext: { timeZone },
      });

      const saved = await stores.memoryStore.getObservation(ctx, observed.observationId);
      expect(saved?.payload).toMatchObject({ extractionContext: { timeZone } });
      const sent = JSON.parse(prompts[0]!.messages[0]!.content);
      expect(sent.timeZone).toBe(timeZone);
      expect(sent.observation.observedLocalDate).toBe("2026-01-02");
    },
  );
  it("does not silently substitute recordedAt for unknown occurredAt", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      kind: "utterance",
      recordedAt: new Date("2026-01-01Z"),
      payload: { text: "明日", extractionContext: {} },
    });
    const observation = JSON.parse(prompt.messages[0]!.content).observation;
    expect(observation.occurredAt).toBeNull();
    // recordedAt での代用は過去ログの取込みで誤るので、occurredAt が無ければ暦日を確定しない。
    expect(observation.observedLocalDate).toBeNull();
    expect(observation.relativeDates).toBeNull();
  });

  it("case 4 (no context): does not smuggle fabrication material into the prompt", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      occurredAt: new Date("2026-01-01T23:00:00Z"),
      payload: { text: "それでお願いします", extractionContext: {} },
    });
    const parsed = JSON.parse(prompt.messages[0]!.content);
    expect(parsed.context).toEqual([]);
    expect(parsed.timeZone).toBeNull();
    expect(parsed.observation.observedLocalDate).toBeNull();
    expect(parsed.observation.relativeDates).toBeNull();
    expect(parsed.observation.text).toBe("それでお願いします");
  });

  it("case 2 (相対日時): missing timeZone alone does not fix a calendar date", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      occurredAt: new Date("2026-01-01T23:00:00Z"),
      payload: { text: "明日は大阪へ出張", extractionContext: { messages: [] } },
    });
    const observation = JSON.parse(prompt.messages[0]!.content).observation;
    expect(observation.observedLocalDate).toBeNull();
    expect(observation.relativeDates).toBeNull();
  });

  it("case 2 (相対日時): missing occurredAt alone does not fix a calendar date, even with timeZone", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      payload: { text: "明日は大阪へ出張", extractionContext: { timeZone: "Asia/Tokyo" } },
    });
    const observation = JSON.parse(prompt.messages[0]!.content).observation;
    expect(observation.occurredAt).toBeNull();
    expect(observation.observedLocalDate).toBeNull();
    expect(observation.relativeDates).toBeNull();
  });

  it("case 2 (相対日時): resolves the JST calendar date across the UTC day boundary when both are present", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T23:00:00Z"),
      occurredAt: new Date("2026-01-01T23:00:00Z"),
      payload: { text: "明日は大阪へ出張", extractionContext: { timeZone: "Asia/Tokyo" } },
    });
    const observation = JSON.parse(prompt.messages[0]!.content).observation;
    // UTC のまま数えると1日誤る。
    expect(observation.observedLocalDate).toBe("2026-01-02");
    expect(observation.relativeDates["明日"]).toBe("2026-01-03");
  });

  it("case 3 (話者違い): the observation's own text/speaker are not replaced by context content", () => {
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      subjectId: "tanaka",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        text: "私は紅茶派",
        speaker: "田中",
        extractionContext: {
          messages: [{ speaker: "佐藤", text: "コーヒーが好き" }],
        },
      },
    });
    const parsed = JSON.parse(prompt.messages[0]!.content);
    expect(parsed.observation.text).toBe("私は紅茶派");
    expect(parsed.observation.speaker).toBe("田中");
    expect(parsed.observation.text).not.toContain("コーヒー");
    expect(parsed.context).toEqual([{ speaker: "佐藤", text: "コーヒーが好き" }]);
  });

  it("case 3 (話者違い): an observation without its own speaker does not inherit a context speaker", () => {
    // observation が既に speaker を持つケースは直前のテストで見ているが、`observationSpeaker(observation) ?? <context由来>` のような
    // 「持たない場合だけ context へフォールバックする」変異を見逃す（`??` の左側が真になり隠れるため）。
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      subjectId: "tanaka",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        text: "それでお願いします",
        extractionContext: {
          messages: [{ speaker: "佐藤", text: "コーヒーが好き" }],
        },
      },
    });
    const parsed = JSON.parse(prompt.messages[0]!.content);
    expect(parsed.observation.speaker).toBeNull();
  });

  it("case 3 (話者違い): provenance always cites the subject observation, never a context speaker", () => {
    const observation: Observation = {
      id: "obs-tanaka" as ObservationId,
      tenantId: "t",
      subjectId: "tanaka",
      kind: "utterance",
      payload: {
        text: "私は紅茶派",
        speaker: "田中",
        extractionContext: { messages: [{ speaker: "佐藤", text: "コーヒーが好き" }] },
      },
      recordedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const memory = buildNewMemoryFromCandidate({
      ctx: { tenantId: "t" },
      observation,
      candidate: { content: "紅茶が好き", provenanceKind: "stated" },
      hashContent: (s) => s,
      extractorVersion: "v1",
      llmModelId: "m",
      promptVersion: "p1",
      halfLifeHours: 24,
      now: new Date("2026-01-01T00:00:00Z"),
      digestFallbackLength: 80,
    });
    expect(memory.provenance).toMatchObject({
      kind: "stated",
      sourceObservationId: "obs-tanaka",
      speaker: "田中",
    });
  });

  it("case 3 (話者違い): a later observer does not have a same-tenant prior observation silently folded into its context", async () => {
    const prompts: PromptSpec[] = [];
    const llmProvider: LLMProvider = {
      complete: async () => {
        throw new Error("unused");
      },
      completeStructured: async (_ctx, req) => {
        prompts.push(req.prompt);
        return req.schema.parse({ memories: [] });
      },
    };
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({ ...stores, llmProvider, hashContent: (s) => s });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "コーヒーが好き",
      speaker: "佐藤",
      subjectId: "sato",
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "私は紅茶派",
      speaker: "田中",
      subjectId: "tanaka",
      extractionContext: { messages: [] },
    });
    expect(prompts).toHaveLength(2);
    const secondPromptObservation = JSON.parse(prompts[1]!.messages[0]!.content);
    expect(secondPromptObservation.context).toEqual([]);
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
