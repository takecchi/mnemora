import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../extraction.js";
import type { Observation } from "../observation.js";
import type { PromptSpec, LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx = { tenantId: "local-date-test" };

function observationAt(occurredAt: Date, timeZone: string | undefined): Observation {
  return {
    id: "o",
    tenantId: "t",
    kind: "utterance",
    recordedAt: new Date("2026-01-01Z"),
    occurredAt,
    payload: { text: "x", extractionContext: timeZone === undefined ? {} : { timeZone } },
  } as unknown as Observation;
}

function parsedPrompt(occurredAt: Date, timeZone: string | undefined) {
  const prompt = buildExtractionPrompt(observationAt(occurredAt, timeZone));
  return { raw: prompt.messages[0]!.content, parsed: JSON.parse(prompt.messages[0]!.content) };
}

describe("Intl の年の書き方（組み直しの前提）", () => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  it("node の Intl は年を4桁に0詰めせず、紀元前は符号が落ちる（この前提が変わったらここで気付く）", () => {
    expect(fmt.format(new Date("0999-06-01T00:00:00Z"))).toBe("999-06-01");
    expect(fmt.format(new Date("+010000-01-01T00:00:00Z"))).toBe("10000-01-01");
    expect(fmt.format(new Date("+275760-09-12T00:00:00Z"))).toBe("275760-09-12");
    // 紀元前は符号が落ちる。天文学年 0 が "1"、-100 が "101"
    expect(fmt.format(new Date("0000-06-01T00:00:00Z"))).toBe("1-06-01");
    expect(fmt.format(new Date("-000100-06-01T00:00:00Z"))).toBe("101-06-01");
  });
  it("Date.parse は 0詰めされていない年の文字列を読めない（旧実装が落ちた理由）", () => {
    expect(Date.parse("999-06-01T00:00:00Z")).toBeNaN();
    expect(Date.parse("10000-01-01T00:00:00Z")).toBeNaN();
  });
  it("それでも組み直した暦日は正しい（天文学年。0詰め4桁・±6桁の拡張年）", () => {
    const cases: Array<[string, string, string]> = [
      ["0999-06-01T00:00:00Z", "Asia/Tokyo", "0999-06-01"],
      ["0999-06-01T20:00:00Z", "Asia/Tokyo", "0999-06-02"],
      ["9999-12-31T20:00:00Z", "Asia/Tokyo", "+010000-01-01"],
      ["+010000-06-15T00:00:00Z", "UTC", "+010000-06-15"],
      ["+275760-09-12T00:00:00Z", "UTC", "+275760-09-12"],
      ["0000-06-01T00:00:00Z", "UTC", "0000-06-01"],
      ["-000100-06-01T00:00:00Z", "UTC", "-000100-06-01"],
      ["-000001-12-31T20:00:00Z", "Asia/Tokyo", "0000-01-01"],
      ["0001-01-01T00:00:00Z", "America/Los_Angeles", "0000-12-31"],
    ];
    for (const [at, tz, local] of cases) {
      const { parsed } = parsedPrompt(new Date(at), tz);
      expect(parsed.observation.observedLocalDate, `${at} ${tz}`).toBe(local);
      expect(parsed.observation.relativeDates["今日"], `${at} ${tz}`).toBe(local);
    }
  });
  it("relativeDates は年をまたいでも、拡張年でも、10文字以上の形で切れない", () => {
    const { parsed } = parsedPrompt(new Date("9999-12-31T20:00:00Z"), "Asia/Tokyo");
    expect(parsed.observation.relativeDates).toEqual({
      昨日: "9999-12-31",
      今日: "+010000-01-01",
      明日: "+010000-01-02",
      明後日: "+010000-01-03",
    });
    const bc = parsedPrompt(new Date("0000-01-01T00:00:00Z"), "UTC").parsed;
    expect(bc.observation.relativeDates).toEqual({
      昨日: "-000001-12-31",
      今日: "0000-01-01",
      明日: "0000-01-02",
      明後日: "0000-01-03",
    });
  });
  it("Date の範囲の端では、範囲を出る日付だけが null になり、落ちない", () => {
    const max = parsedPrompt(new Date("+275760-09-13T00:00:00Z"), "UTC").parsed;
    expect(max.observation.relativeDates).toEqual({
      昨日: "+275760-09-12",
      今日: "+275760-09-13",
      明日: null,
      明後日: null,
    });
    const min = parsedPrompt(new Date("-271821-04-20T00:00:00Z"), "UTC").parsed;
    expect(min.observation.observedLocalDate).toBe("-271821-04-20");
    expect(min.observation.relativeDates["昨日"]).toBeNull();
    const outside = parsedPrompt(new Date("-271821-04-20T00:00:00Z"), "America/Los_Angeles").parsed;
    expect(outside.observation.observedLocalDate).toBe("-271821-04-19");
    expect(outside.observation.relativeDates["今日"]).toBeNull();
  });
});

describe("偽の LLM が呼ばれる（全文フォールバックへ黙って倒れない）", () => {
  const values: Array<[string, string, string, string]> = [
    ["0999年", "0999-06-01T00:00:00Z", "Asia/Tokyo", "0999-06-01"],
    ["JST で10000年の元日", "9999-12-31T20:00:00Z", "Asia/Tokyo", "+010000-01-01"],
    ["+010000年", "+010000-06-15T00:00:00Z", "Asia/Tokyo", "+010000-06-15"],
    ["紀元前（天文学年 -100）", "-000100-06-01T00:00:00Z", "Asia/Tokyo", "-000100-06-01"],
  ];
  for (const extract of ["sync", "deferred"] as const) {
    for (const [label, at, tz, local] of values) {
      it(`${extract}: ${label}`, async () => {
        const prompts: PromptSpec[] = [];
        const llmProvider: LLMProvider = {
          complete: async () => {
            throw new Error("unused");
          },
          completeStructured: async (_ctx, req) => {
            prompts.push(req.prompt);
            return req.schema.parse({
              memories: [{ content: "抽出された記憶", provenanceKind: "stated" }],
            });
          },
        };
        const stores = createFakeRuntimeStores();
        const runtime = createRuntime({ ...stores, llmProvider, hashContent: (s) => s });
        const observed = await runtime.observe(ctx, {
          kind: "utterance",
          text: "明日は大阪へ出張",
          occurredAt: new Date(at),
          extract,
          extractionContext: { timeZone: tz },
        });
        if (extract === "deferred") {
          const ticked = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60000 });
          expect(ticked.failed).toBe(0);
        } else {
          expect(observed.extraction).toBe("ok");
        }
        expect(prompts).toHaveLength(1);
        const sent = JSON.parse(prompts[0]!.messages[0]!.content);
        expect(sent.observation.observedLocalDate).toBe(local);
        expect(sent.observation.relativeDates["今日"]).toBe(local);
        const saved = await stores.memoryStore.getObservation(ctx, observed.observationId);
        expect(saved).not.toBeNull();
      });
    }
  }
});

describe("1000〜9999年と timeZone なしは、プロンプトの content が直す前と1バイトも変わらない", () => {
  const golden: Array<[string, string | undefined, string]> = [
    [
      "1969-12-31T23:59:59.999Z",
      "Asia/Tokyo",
      '{"observation":{"text":"x","speaker":null,"subjectId":null,"occurredAt":"1969-12-31T23:59:59.999Z","recordedAt":"2026-01-01T00:00:00.000Z","observedLocalDate":"1970-01-01","relativeDates":{"昨日":"1969-12-31","今日":"1970-01-01","明日":"1970-01-02","明後日":"1970-01-03"}},"context":[],"timeZone":"Asia/Tokyo"}',
    ],
    [
      "2026-01-01T23:00:00Z",
      "Asia/Tokyo",
      '{"observation":{"text":"x","speaker":null,"subjectId":null,"occurredAt":"2026-01-01T23:00:00.000Z","recordedAt":"2026-01-01T00:00:00.000Z","observedLocalDate":"2026-01-02","relativeDates":{"昨日":"2026-01-01","今日":"2026-01-02","明日":"2026-01-03","明後日":"2026-01-04"}},"context":[],"timeZone":"Asia/Tokyo"}',
    ],
    [
      "1000-01-01T00:00:00Z",
      "Asia/Tokyo",
      '{"observation":{"text":"x","speaker":null,"subjectId":null,"occurredAt":"1000-01-01T00:00:00.000Z","recordedAt":"2026-01-01T00:00:00.000Z","observedLocalDate":"1000-01-01","relativeDates":{"昨日":"0999-12-31","今日":"1000-01-01","明日":"1000-01-02","明後日":"1000-01-03"}},"context":[],"timeZone":"Asia/Tokyo"}',
    ],
    [
      "2026-03-31T23:00:00Z",
      "America/Los_Angeles",
      '{"observation":{"text":"x","speaker":null,"subjectId":null,"occurredAt":"2026-03-31T23:00:00.000Z","recordedAt":"2026-01-01T00:00:00.000Z","observedLocalDate":"2026-03-31","relativeDates":{"昨日":"2026-03-30","今日":"2026-03-31","明日":"2026-04-01","明後日":"2026-04-02"}},"context":[],"timeZone":"America/Los_Angeles"}',
    ],
    [
      "2024-02-28T12:00:00Z",
      undefined,
      '{"observation":{"text":"x","speaker":null,"subjectId":null,"occurredAt":"2024-02-28T12:00:00.000Z","recordedAt":"2026-01-01T00:00:00.000Z","observedLocalDate":null,"relativeDates":null},"context":[],"timeZone":null}',
    ],
  ];
  for (const [at, tz, expected] of golden) {
    it(`${at} ${tz ?? "(timeZone なし)"}`, () => {
      expect(parsedPrompt(new Date(at), tz).raw).toBe(expected);
    });
  }
  it("1000〜9999年の全域で、旧実装の書き方（Intl の文字列 + Date.parse）と同じ暦日になる", () => {
    const fmt = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC", "Pacific/Kiritimati"]) {
      for (let year = 1001; year <= 9990; year += 37) {
        for (const md of ["-01-01T00:30:00Z", "-02-28T23:30:00Z", "-12-31T12:00:00Z"]) {
          const at = new Date(`${String(year).padStart(4, "0")}${md}`);
          const old = fmt(tz).format(at);
          const { parsed } = parsedPrompt(at, tz);
          expect(parsed.observation.observedLocalDate, `${at.toISOString()} ${tz}`).toBe(old);
          const oldRel = [-1, 0, 1, 2].map((o) =>
            new Date(Date.parse(`${old}T00:00:00Z`) + o * 86400000).toISOString().slice(0, 10),
          );
          expect(Object.values(parsed.observation.relativeDates)).toEqual(oldRel);
        }
      }
    }
  });
});
