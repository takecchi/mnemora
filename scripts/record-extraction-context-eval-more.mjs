// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
//
// Issue #704 の続き。マネージャー判断（ADR 0299 追記節「5」）を受け、
// packages/core/src/__tests__/fixtures/extraction-context-eval-more-cases.mjs に
// commit 済みの独立評価ケース（i: 文脈付き参照4本 / j: 曖昧な参照2本 /
// k: 複雑な日時3本 / l: 長い文脈の変種3本、計12本）を録音するためのスクリプト。
//
// `scripts/record-extraction-context-eval.mjs`（eval-a1〜d4、各1回）・
// `scripts/record-extraction-context-eval-coverage.mjs`（eval-e1/f1/g1/h1、各3回）
// とは別物。このスクリプトは各ケースを5回ずつ叩き、再現性を記録する。
//
// ⛔ このスクリプトは書き換えない ── 実行して結果を見てからケースや期待値を
// 結果に合わせて直すことはしない。
//
// 実行回数はケース数 × 5 に固定される（試し撃ちはしない）。呼ぶ前に全リクエスト分の
// 保守的な費用見積りを合算し、上限を超えるなら1回も呼ばずに中断する。
//
// 使い方: node --env-file=.env scripts/record-extraction-context-eval-more.mjs <output.json>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
import {
  moreEvalCases,
  MORE_EVAL_TENANT_ID,
  MORE_EVAL_RECORDED_AT,
} from "../packages/core/src/__tests__/fixtures/extraction-context-eval-more-cases.mjs";

const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
// ⛔ 依頼の上限（$1.00）そのもの。この値自体は超えない——予約合計がこれを超えるなら
// 1回も呼ばずに中断する。
const MAX_USD = 1.0;
const MAX_COMPLETION_TOKENS = 1500;
const RUNS_PER_CASE = 5;

function buildObservation(c) {
  const extractionContext = {};
  if (c.input.contextMessages !== null) extractionContext.messages = c.input.contextMessages;
  if (c.input.timeZone !== null) extractionContext.timeZone = c.input.timeZone;
  const observation = {
    id: c.id,
    tenantId: MORE_EVAL_TENANT_ID,
    kind: "utterance",
    subjectId: c.input.subjectId,
    recordedAt: new Date(MORE_EVAL_RECORDED_AT),
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

// 1) 全ケース × 5回分のプロンプトを先に組み立て、費用の保守的な上限を合算する。
//    実 API はまだ1回も呼ばない。
const planned = moreEvalCases.map((c) => {
  const observation = buildObservation(c);
  const prompt = buildExtractionPrompt(observation);
  const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format })) + 4096;
  // Rates: official GPT-4.1 mini model page ($0.40/1M input, $1.60/1M output).
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

// 2) 予算内であることを確認できたので、ここで初めて実 API を呼ぶ（ケースごとに5回、計画通り）。
//    ネットワークエラー等で叩き直した回数も retries として記録する（黙って握り潰さない）。
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
      kind: "independent semantic evaluation, Issue #704 follow-up (contextual reference: time/date/quantity/location; ambiguous reference: time/quantity; complex relative date: month-crossing/range/recurring; long-context variants of eval-h1); 5 runs per case for reproducibility",
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
