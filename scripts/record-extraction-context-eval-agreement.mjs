// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
//
// Issue #704 のさらに続き。PR #740（ADR 0299 追記3）が残した未検証の仮説「同意の言い方
// （『それでお願いします』『大丈夫です』等）は動かしていない要因」を、初めて単独の要因
// として動かすための録音。
// `packages/core/src/__tests__/fixtures/extraction-context-eval-agreement-cases.mjs` に
// commit 済みの10ケース（話題A=集合場所・話題B=締切、各5変種: 対照＋4つの同意の言い方）を、
// 各5回ずつ叩く。
//
// `scripts/record-extraction-context-eval-factors.mjs` を模した形（RUNS_PER_CASE=5）。
//
// ⛔ このスクリプトは書き換えない —— 実行して結果を見てからケースや期待値を
// 結果に合わせて直すことはしない。
//
// 実行回数はケース数 × 5 に固定される（試し撃ちはしない）。呼ぶ前に全リクエスト分の
// 保守的な費用見積りを合算し、上限を超えるなら1回も呼ばずに中断する。
//
// 見積り式（この依頼の上限 $0.05 のための根拠。マネージャー依頼の例に従う:
// 「prompt の最大値 × 1.5、completion の上限 300」）:
// - #737（`extraction-context-eval-more-recorded.json`、60リクエスト）と #740
//   （`extraction-context-eval-factors-recorded.json`、60リクエスト）の実測
//   prompt_tokens の最大値は、双方合わせて 708（#737側）。本ファイルの10ケースは
//   いずれも PR #740 の m0（4件の contextMessages、実測 prompt_tokens 622〜626）と
//   文脈の長さが同一で、動かしているのは短い同意フレーズ1つだけであり、708を
//   超える理由が無い——それでも実測値そのものではなく、その1.5倍
//   （708 * 1.5 = 1062）を1リクエストあたりの保守的な上限として使う。
// - completion 側は #737/#740 の実測 completion_tokens 最大値が135（#737側）
//   であるところ、依頼の指定どおり上限を300に固定する（135の約2.2倍の余裕）。
// - 1リクエストの予約費用 = (1062 * 0.40 + 300 * 1.60) / 1e6 ドル
//   （$0.40/1M入力・$1.60/1M出力、GPT-4.1 mini 公式モデルページの単価）。
// - 50リクエスト（10ケース×5回）の合計予約は (1062*0.4 + 300*1.6) / 1e6 * 50
//   = $0.04524（上限$0.05の90.48%）。
//
// 使い方: node --env-file=.env scripts/record-extraction-context-eval-agreement.mjs <output.json>
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
import {
  agreementEvalCases,
  AGREEMENT_EVAL_TENANT_ID,
  AGREEMENT_EVAL_RECORDED_AT,
} from "../packages/core/src/__tests__/fixtures/extraction-context-eval-agreement-cases.mjs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
// ⛔ 依頼の上限（$0.05）そのもの。この値自体は超えない——予約合計がこれを超えるなら
// 1回も呼ばずに中断する。
const MAX_USD = 0.05;
// 見積り式は上のコメント参照。#737/#740 の実測 prompt_tokens 最大値（708）× 1.5。
// 実測値そのものではなく安全側の定数として使う——本ファイルの各リクエストの実際の
// プロンプトを個別に測ってはいない（測るまでもなく、m0と同じ長さの文脈であるため
// 708を大きく超える理由が無い）。
const PROMPT_TOKEN_BOUND = 708 * 1.5;
const MAX_COMPLETION_TOKENS = 300;
const RUNS_PER_CASE = 5;

function buildObservation(c) {
  const extractionContext = {};
  if (c.input.contextMessages !== null) extractionContext.messages = c.input.contextMessages;
  if (c.input.timeZone !== null) extractionContext.timeZone = c.input.timeZone;
  const observation = {
    id: c.id,
    tenantId: AGREEMENT_EVAL_TENANT_ID,
    kind: "utterance",
    subjectId: c.input.subjectId,
    recordedAt: new Date(AGREEMENT_EVAL_RECORDED_AT),
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
const planned = agreementEvalCases.map((c) => {
  const observation = buildObservation(c);
  const prompt = buildExtractionPrompt(observation);
  // Rates: official GPT-4.1 mini model page ($0.40/1M input, $1.60/1M output).
  const reserve = (PROMPT_TOKEN_BOUND * 0.4) / 1e6 + (MAX_COMPLETION_TOKENS * 1.6) / 1e6;
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
    topic: p.case.topic,
    variant: p.case.variant,
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
      kind: "independent semantic evaluation, Issue #704 further follow-up (agreement-phrasing factor: 4 phrasings + 1 control, 2 topics x 5 variants); 5 runs per case for reproducibility",
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
