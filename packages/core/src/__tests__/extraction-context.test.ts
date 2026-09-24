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
    // occurredAt が無ければ recordedAt があっても暦日を確定しない
    // （マネージャー定義のケース2「相対日時」の根拠: recordedAt での代用は
    // 過去ログの取込みで誤る）。
    expect(observation.observedLocalDate).toBeNull();
    expect(observation.relativeDates).toBeNull();
  });

  // --- Issue #689 本文の4回帰ケースのうち、マネージャーが実装前に定義した期待値と根拠
  //     （このセッションが引き継いだ時点で追加）。「文脈なし」はこの PR に無かった
  //     4件目のケース。それ以外3件は recorded fixture（下の describe）で意味評価まで
  //     見ているが、ここでは意味評価と切り離した契約（プロンプトに何が渡るか）だけを見る。

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
    // 契約として検査できるのはここまで（プロンプトに捏造の材料が入らないこと）。
    // 「具体的な対象を補わない」という意味評価は本 PR では未評価
    // （実 API を叩けないため。ADR 参照）。
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
    // UTC 2026-01-01T23:00Z は Asia/Tokyo では 2026-01-02。UTC のまま数えると1日誤る
    // （マネージャー定義のケース2の根拠）。
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
    // 佐藤の発話は context 欄にだけ残り、observation 欄には出ない。
    expect(parsed.context).toEqual([{ speaker: "佐藤", text: "コーヒーが好き" }]);
  });

  it("case 3 (話者違い): an observation without its own speaker does not inherit a context speaker", () => {
    // observation 自身が speaker を持たない場合でも、context の話者（佐藤）が
    // observation.speaker として漏れ出さないことを確かめる。observation が既に
    // speaker を持つケースは直前のテストで見ているが、あちらは
    // `observationSpeaker(observation) ?? <context由来>` のような「持たない場合だけ
    // context へフォールバックする」変異を見逃す（`??` の左側が真になり隠れるため）。
    const prompt = buildExtractionPrompt({
      id: "o",
      tenantId: "t",
      subjectId: "tanaka",
      kind: "utterance",
      recordedAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        text: "それでお願いします",
        // speaker を持たせない。
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
    // sourceObservationId は常に対象の observation を指す。context 中の佐藤の発話から
    // 独立した観測・出典は作られない（構造的な保証——buildProvenance は
    // params.observation だけを見る。extraction.ts 参照）。
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
    // 呼び手が渡さなかった限り、同一テナントの直前の観測（佐藤の発話）が context へ
    // 自動で足されない。呼び手が選んだ文脈だけを使う、という ADR の決定の歯止め。
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
