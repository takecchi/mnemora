// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
//
// これは packages/core/src/__tests__/fixtures/extraction-context-recorded.json
// （見て調整した開発ケース）を録るスクリプトではない。あちらとは独立に、
// packages/core/src/__tests__/fixtures/extraction-context-eval-cases.mjs に
// commit 済みの評価ケース（Issue #689 本文の完了条件だけから実装より前に定義したもの）
// を録音するためのスクリプトである。
//
// ⛔ このスクリプトは書き換えない ── 実行して結果を見てからケースや期待値を
// 結果に合わせて直すこと（= extraction-context-eval-cases.mjs の書き換え）はしない。
//
// 実行回数はケース数に固定される（試し撃ちはしない）。呼ぶ前に全ケース分の
// 保守的な費用見積りを合算し、上限を超えるなら1回も呼ばずに中断する。
//
// 使い方: node --env-file=.env scripts/record-extraction-context-eval.mjs <output.json>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
import {
  evalCases,
  EVAL_TENANT_ID,
  EVAL_RECORDED_AT,
} from "../packages/core/src/__tests__/fixtures/extraction-context-eval-cases.mjs";

const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
const MAX_USD = 0.1;
const MAX_COMPLETION_TOKENS = 1500;

function buildObservation(c) {
  const extractionContext = {};
  if (c.input.contextMessages !== null) extractionContext.messages = c.input.contextMessages;
  if (c.input.timeZone !== null) extractionContext.timeZone = c.input.timeZone;
  const observation = {
    id: c.id,
    tenantId: EVAL_TENANT_ID,
    kind: "utterance",
    subjectId: c.input.subjectId,
    recordedAt: new Date(EVAL_RECORDED_AT),
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

// 1) 全ケース分のプロンプトを先に組み立て、費用の保守的な上限を合算する。
//    実 API はまだ1回も呼ばない。
const planned = evalCases.map((c) => {
  const observation = buildObservation(c);
  const prompt = buildExtractionPrompt(observation);
  // Conservative byte-based input bound; reserve output before sending.
  // Rates: official GPT-4.1 mini model page ($0.40/1M input, $1.60/1M output).
  const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format })) + 4096;
  const reserve = (inputBound * 0.4) / 1e6 + (MAX_COMPLETION_TOKENS * 1.6) / 1e6;
  return { case: c, observation, prompt, reserve };
});
const totalReserve = planned.reduce((sum, p) => sum + p.reserve, 0);
console.log(
  JSON.stringify({
    plannedRequests: planned.length,
    projectedReservedUsd: totalReserve,
    maxUsd: MAX_USD,
  }),
);
if (totalReserve > MAX_USD) {
  throw new Error(
    `Projected reserved cost $${totalReserve.toFixed(4)} exceeds budget $${MAX_USD} for ${planned.length} requests. Aborting before making any call.`,
  );
}

// 2) 予算内であることを確認できたので、ここで初めて実 API を呼ぶ（ケースごとに1回、計画通り）。
const rows = [];
let usd = 0;
for (const p of planned) {
  const result = await client.chat.completions.create({
    model,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    messages: [{ role: "system", content: p.prompt.system }, ...p.prompt.messages],
    response_format: { type: "json_schema", json_schema: format },
  });
  usd += p.reserve; // reserve rather than undercount on missing usage or errors
  rows.push({
    id: p.case.id,
    category: p.case.category,
    observation: p.observation,
    prompt: p.prompt,
    response: result.choices[0],
    usage: result.usage,
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
      kind: "independent semantic evaluation; cases defined from Issue #689 before implementation was read",
      requests: rows.length,
      reservedUsd: usd,
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ requests: rows.length, reservedUsd: usd, output }));
