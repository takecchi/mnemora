// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
//
// ⛔ このスクリプトは書き換えない。実行して結果を見てから、ケースや期待値を結果に合わせて直すことはしない。
// ⛔ 実行回数はケース数 × 5 に固定する(試し撃ちはしない)。呼ぶ前に全リクエスト分の保守的な費用見積りを合算し、
// 上限を超えるなら1回も呼ばずに中断する。
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
import {
  factorsEvalCases,
  FACTORS_EVAL_TENANT_ID,
  FACTORS_EVAL_RECORDED_AT,
} from "../packages/core/src/__tests__/fixtures/extraction-context-eval-factors-cases.mjs";

const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
// ⛔ 依頼の上限そのもの。予約合計がこれを超えるなら1回も呼ばずに中断する。
const MAX_USD = 0.1;
// 見積りは実測に合わせて調整してある。バイト数をそのままトークン数とみなす近似は実測の約4.2倍の過大見積りなので、固定バイト余白は足さない。
// 足すと上限に対して過大になり、1回も呼べずに中断する。
// completion_tokens の 300 は実測最大 135 の約2.2倍で、実測より薄くしていない。
const MAX_COMPLETION_TOKENS = 300;
const RUNS_PER_CASE = 5;

function buildObservation(c) {
  const extractionContext = {};
  if (c.input.contextMessages !== null) extractionContext.messages = c.input.contextMessages;
  if (c.input.timeZone !== null) extractionContext.timeZone = c.input.timeZone;
  const observation = {
    id: c.id,
    tenantId: FACTORS_EVAL_TENANT_ID,
    kind: "utterance",
    subjectId: c.input.subjectId,
    recordedAt: new Date(FACTORS_EVAL_RECORDED_AT),
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

const planned = factorsEvalCases.map((c) => {
  const observation = buildObservation(c);
  const prompt = buildExtractionPrompt(observation);
  const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format }));
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

// ネットワークエラー等で叩き直した回数も retries として記録する(黙って握り潰さない)。
const cases = [];
let usd = 0;
let retries = 0;
for (const p of planned) {
  const runs = [];
  for (let i = 0; i < RUNS_PER_CASE; i++) {
    let result;
    for (;;) {
      try {
        result = await client.chat.completions.create({
          model,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          messages: [{ role: "system", content: p.prompt.system }, ...p.prompt.messages],
          response_format: { type: "json_schema", json_schema: format },
        });
        break;
      } catch (error) {
        retries += 1;
        console.error(
          JSON.stringify({
            caseId: p.case.id,
            run: i + 1,
            retryAttempt: retries,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (retries > 10) throw error;
      }
    }
    usd += p.reserve;
    runs.push({ run: i + 1, response: result.choices[0], usage: result.usage });
  }
  cases.push({
    id: p.case.id,
    topic: p.case.topic,
    factorVariant: p.case.factorVariant,
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
      kind: "independent semantic evaluation, Issue #704 further follow-up (factor isolation for the long-context eval-l3 regression: wording/count/position, 2 topics x 6 variants); 5 runs per case for reproducibility",
      runsPerCase: RUNS_PER_CASE,
      requests: cases.reduce((sum, c) => sum + c.runs.length, 0),
      retries,
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
    retries,
    reservedUsd: usd,
    output,
  }),
);
