// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
//
// Issue #704 のさらに続き。PR #737（`extraction-context-eval-more-cases.mjs` の
// eval-l1/l2/l3）が交絡させたまま残した「件数・位置・言い回しのどれが l3 の
// 2/5（過半数割れ）に効いたか」を、要因を1つずつ動かして切り分けるための録音。
// `packages/core/src/__tests__/fixtures/extraction-context-eval-factors-cases.mjs` に
// commit 済みの12ケース（話題A=集合場所・話題B=締切、各6変種: m0基準/m1言い回し/
// m2件数少/m3件数多/m4位置末尾/m5位置中間）を、各5回ずつ叩く。
//
// `scripts/record-extraction-context-eval-more.mjs` を模した形（RUNS_PER_CASE=5）。
// 違いは予算上限のみ——この依頼の上限は $0.10（前回の $1.00 より厳しい）。
//
// ⛔ このスクリプトは書き換えない —— 実行して結果を見てからケースや期待値を
// 結果に合わせて直すことはしない。
//
// 実行回数はケース数 × 5 に固定される（試し撃ちはしない）。呼ぶ前に全リクエスト分の
// 保守的な費用見積りを合算し、上限を超えるなら1回も呼ばずに中断する。
//
// 使い方: node --env-file=.env scripts/record-extraction-context-eval-factors.mjs <output.json>
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
// ⛔ 依頼の上限（$0.10）そのもの。この値自体は超えない——予約合計がこれを超えるなら
// 1回も呼ばずに中断する。
const MAX_USD = 0.1;
// `record-extraction-context-eval-more.mjs`（上限$1.00）は MAX_COMPLETION_TOKENS=1500・
// 入力バイト数に固定4096バイトの余白を足していたが、この依頼の上限（$0.10）に対しては
// その見積りが過大すぎて1回も呼ばずに中断してしまう（実測: 4096バイト余白のままだと
// 60リクエスト分の予約合計は$0.307で上限超過）。そこで、実測データ（同じ形式・
// 同程度の文脈件数=最大8件の `extraction-context-eval-more-recorded.json`、60リクエスト）
// に照らして見積りを調整した:
// - 実測の completion_tokens 最大値は135（60リクエスト中）。300はその約2.2倍の余裕を
//   持たせた値であり、実測より薄くしていない。
// - 実測の prompt_tokens 最大値は708だが、本スクリプトの入力見積り（プロンプト+
//   response_format のJSON文字列のバイト数をそのままトークン数とみなす）は、同程度の
//   件数のケースで最大2961バイトになる——バイト数をそのままトークン数とみなす近似
//   自体が実測の708トークンに対し約4.2倍の過大見積りであり、追加の固定バイト余白
//   （旧スクリプトの+4096）は不要と判断した（近似そのものにすでに十分な安全マージンが
//   ある）。
// 見積りの結果は60リクエストで$0.0938（上限$0.10の94%、実行前にログへ出す）。
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

// 1) 全ケース × 5回分のプロンプトを先に組み立て、費用の保守的な上限を合算する。
//    実 API はまだ1回も呼ばない。
const planned = factorsEvalCases.map((c) => {
  const observation = buildObservation(c);
  const prompt = buildExtractionPrompt(observation);
  const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format }));
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
