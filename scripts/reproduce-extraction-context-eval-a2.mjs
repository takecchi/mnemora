// ⛔ このスクリプトはチューニング用途ではない。実装を1バイトも変えずに同じ入力の再現性を測る。`buildExtractionPrompt` は main のまま(import するだけで書き換えない)。
// 実行前に費用の保守的な上限を合算し、超えるなら1回も呼ばずに中断する。
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
import { evalCases } from "../packages/core/src/__tests__/fixtures/extraction-context-eval-cases.mjs";

const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
const MAX_USD = 0.1;
const MAX_COMPLETION_TOKENS = 1500;

const CASE_ID = "eval-a2-meeting-time-reference";
const evalCase = evalCases.find((c) => c.id === CASE_ID);
if (!evalCase) throw new Error(`case ${CASE_ID} not found in extraction-context-eval-cases.mjs`);

function buildObservation(c) {
  const extractionContext = {};
  if (c.input.contextMessages !== null) extractionContext.messages = c.input.contextMessages;
  if (c.input.timeZone !== null) extractionContext.timeZone = c.input.timeZone;
  const observation = {
    id: `${c.id}-repro`,
    tenantId: "context-eval-independent-repro",
    kind: "utterance",
    subjectId: c.input.subjectId,
    recordedAt: new Date("2026-04-15T00:00:00.000Z"),
    payload: {
      text: c.input.text,
      speaker: c.input.speaker,
      extractionContext,
    },
  };
  if (c.input.occurredAt !== null) observation.occurredAt = new Date(c.input.occurredAt);
  return observation;
}

const observation = buildObservation(evalCase);
const prompt = buildExtractionPrompt(observation);
const format = translateForOpenAIStructuredOutput("extraction", ExtractionResultSchema);

const N = Number(process.argv[3] ?? 5);
const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format })) + 4096;
const reservePerCall = (inputBound * 0.4) / 1e6 + (MAX_COMPLETION_TOKENS * 1.6) / 1e6;
const totalReserve = reservePerCall * N;
console.log(
  JSON.stringify({ plannedRequests: N, projectedReservedUsd: totalReserve, maxUsd: MAX_USD }),
);
if (totalReserve > MAX_USD) {
  throw new Error(
    `Projected reserved cost $${totalReserve.toFixed(4)} exceeds budget $${MAX_USD} for ${N} requests. Aborting before making any call.`,
  );
}

function includesTarget(memories) {
  const text = memories.map((m) => [m.content, m.digest].filter(Boolean).join("\n")).join("\n");
  return evalCase.expect.includes.every((word) => text.includes(word));
}

const rows = [];
let usd = 0;
for (let i = 0; i < N; i++) {
  const result = await client.chat.completions.create({
    model,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    messages: [{ role: "system", content: prompt.system }, ...prompt.messages],
    response_format: { type: "json_schema", json_schema: format },
  });
  usd += reservePerCall;
  const memories = JSON.parse(result.choices[0].message.content).memories;
  rows.push({ run: i + 1, memories, passed: includesTarget(memories) });
}

const survived = rows.filter((r) => r.passed).length;
const output = process.argv[2];
if (!output) throw new Error("Pass an output filename");
writeFileSync(
  output,
  JSON.stringify(
    {
      model,
      caseId: CASE_ID,
      recordedAt: new Date().toISOString(),
      kind: "reproducibility check on unmodified main buildExtractionPrompt (Issue #704, not a tuning run)",
      requests: N,
      reservedUsd: usd,
      survived,
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ requests: N, survived, output }));
