// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
// ⛔ ケースや期待値は、実行して結果を見てから結果に合わせて直さない。
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
import {
  coverageEvalCases,
  COVERAGE_TENANT_ID,
  COVERAGE_RECORDED_AT,
} from "../packages/core/src/__tests__/fixtures/extraction-context-eval-coverage-cases.mjs";

const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
const MAX_USD = 0.2;
const MAX_COMPLETION_TOKENS = 1500;
const RUNS_PER_CASE = 3;

function buildObservation(c) {
  const extractionContext = {};
  if (c.input.contextMessages !== null) extractionContext.messages = c.input.contextMessages;
  if (c.input.timeZone !== null) extractionContext.timeZone = c.input.timeZone;
  const observation = {
    id: c.id,
    tenantId: COVERAGE_TENANT_ID,
    kind: "utterance",
    subjectId: c.input.subjectId,
    recordedAt: new Date(COVERAGE_RECORDED_AT),
    payload: {
      text: c.input.text,
      speaker: c.input.speaker,
      extractionContext,
    },
  };
  if (c.input.occurredAt !== null) observation.occurredAt = new Date(c.input.occurredAt);
  return observation;
}

const format = translateForOpenAIStructuredOutput("extraction", ExtractionResultSchema);

const planned = coverageEvalCases.map((c) => {
  const observation = buildObservation(c);
  const prompt = buildExtractionPrompt(observation);
  const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format })) + 4096;
  const reserve = (inputBound * 0.4) / 1e6 + (MAX_COMPLETION_TOKENS * 1.6) / 1e6;
  return { case: c, observation, prompt, reserve };
});
const totalReserve = planned.reduce((sum, p) => sum + p.reserve, 0) * RUNS_PER_CASE;
console.log(
  JSON.stringify({
    plannedCases: planned.length,
    runsPerCase: RUNS_PER_CASE,
    plannedRequests: planned.length * RUNS_PER_CASE,
    projectedReservedUsd: totalReserve,
    maxUsd: MAX_USD,
  }),
);
if (totalReserve > MAX_USD) {
  throw new Error(
    `Projected reserved cost $${totalReserve.toFixed(4)} exceeds budget $${MAX_USD} for ${planned.length * RUNS_PER_CASE} requests. Aborting before making any call.`,
  );
}

const cases = [];
let usd = 0;
for (const p of planned) {
  const runs = [];
  for (let i = 0; i < RUNS_PER_CASE; i++) {
    const result = await client.chat.completions.create({
      model,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      messages: [{ role: "system", content: p.prompt.system }, ...p.prompt.messages],
      response_format: { type: "json_schema", json_schema: format },
    });
    usd += p.reserve;
    runs.push({ run: i + 1, response: result.choices[0], usage: result.usage });
  }
  cases.push({
    id: p.case.id,
    category: p.case.category,
    observation: p.observation,
    prompt: p.prompt,
    runs,
  });
}

const output = process.argv[2];
if (!output) throw new Error("Pass an output filename");
writeFileSync(
  output,
  JSON.stringify(
    {
      model,
      recordedAt: new Date().toISOString(),
      kind: "independent semantic evaluation of Issue #704 uncovered categories (ambiguous reference / complex relative date / 3+ speakers / long context); 3 runs per case for reproducibility",
      runsPerCase: RUNS_PER_CASE,
      requests: cases.reduce((sum, c) => sum + c.runs.length, 0),
      reservedUsd: usd,
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    cases: cases.length,
    requests: cases.reduce((sum, c) => sum + c.runs.length, 0),
    reservedUsd: usd,
    output,
  }),
);
