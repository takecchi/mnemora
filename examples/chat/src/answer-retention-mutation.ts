import type { Ctx, PromptSpec, Runtime } from "@mnemora/core";
import type { AnswerCase, AnswerVerdict } from "./answer-case.js";
import { gradeAnswer } from "./answer-case.js";
import type { CountingEmbeddingProvider, CountingLLMProvider } from "./answer-bench.js";
import { runAnswerCase } from "./answer-bench.js";
import type { AnswerJudgement } from "./answer-judge.js";
import { judgeAnswer } from "./answer-judge.js";

/**
 * 「回答評価」側の陽性対照の変異の定義を1箇所に集約する。記録側（`recordAnswer`）と再生側のテストが
 * 同じ関数を呼ぶ。2箇所に書き写すと、記録した変異と検査している変異が静かにずれる。
 *
 * `recordAnswer` に直接組み込む。`record answer` は毎回カセットを全置換するので、変異が別スクリプトだけに
 * あると、次の全置換でこの変異分だけが消える。
 *
 * `RecallResult` ではなく `PromptSpec` を変異させる。`sourceObservationId` は Postgres の行のままなので、
 * 出典を保ったまま「要約が失敗したふり」を、経路を新設せずに再現できる。
 *
 * 対象はケース `pref-tea-over-coffee` の1件だけ。
 */
export const RETENTION_MUTATION_CASE_ID = "pref-tea-over-coffee";

/** 元の digest 行に一意に含まれる、答えを言い当てている部分文字列。記録時点の実 API の抽出結果に依存する値。 */
export const RETENTION_MUTATION_TARGET_SUBSTRING =
  "打ち合わせのとき、飲み物はコーヒーより紅茶のほうが好き";

export const RETENTION_MUTATION_REPLACEMENT = "[要約失敗。内容は保持していません]";

/**
 * `promptSpec.messages[0].content` の対象部分文字列を置き換えた新しい `PromptSpec` を返す。
 * 見つからなければ例外を投げる。置き換わっていないまま進むと、変異が効いていないのに緑になる。
 * `system` は変えない。
 */
export function applyRetentionMutation(promptSpec: PromptSpec): PromptSpec {
  const message = promptSpec.messages[0];
  if (message === undefined) {
    throw new Error(
      "applyRetentionMutation: promptSpec.messages が空である。変異させる対象が無い。",
    );
  }
  if (!message.content.includes(RETENTION_MUTATION_TARGET_SUBSTRING)) {
    throw new Error(
      "applyRetentionMutation: 変異対象の部分文字列" +
        `${JSON.stringify(RETENTION_MUTATION_TARGET_SUBSTRING)} が見つからない。` +
        "recall の digest が記録時点から変わった可能性がある——記録をやり直す前に原因を確かめること。",
    );
  }
  const mutatedContent = message.content.replace(
    RETENTION_MUTATION_TARGET_SUBSTRING,
    RETENTION_MUTATION_REPLACEMENT,
  );
  return {
    ...promptSpec,
    messages: [{ ...message, content: mutatedContent }, ...promptSpec.messages.slice(1)],
  };
}

export interface RetentionMutationRecordResult {
  caseId: string;
  originalVerdict: AnswerVerdict;
  originalJudgement: AnswerJudgement;
  mutatedAnswer: string;
  mutatedVerdict: AnswerVerdict;
  mutatedJudgement: AnswerJudgement;
}

/**
 * `record answer` の一部として呼ぶ、陽性対照の記録手順。変異後の `PromptSpec` で回答生成と judge を1回ずつ呼ぶ。
 * この関数はカセットに触れない。provider が `RecordingLLMProvider` を包んでいれば自動で記録される。
 * ここで `pass`/`fail` を assert しない。実 API の応答は決定的でなく、実測前に期待を固定しすぎるため。
 */
export async function recordRetentionMutationPositiveControl(
  runtime: Runtime,
  llmProvider: CountingLLMProvider,
  embeddingProvider: CountingEmbeddingProvider,
  judgeLLMProvider: CountingLLMProvider,
  cases: readonly AnswerCase[],
  tenantPrefix: string,
): Promise<RetentionMutationRecordResult> {
  const answerCase = cases.find((c) => c.id === RETENTION_MUTATION_CASE_ID);
  if (answerCase === undefined) {
    throw new Error(
      `recordRetentionMutationPositiveControl: ケース ${RETENTION_MUTATION_CASE_ID} が ` +
        "渡されたケース集合に見つからない。",
    );
  }

  const original = await runAnswerCase(
    runtime,
    llmProvider,
    embeddingProvider,
    judgeLLMProvider,
    answerCase,
    `${tenantPrefix}-retention-mutation`,
  );

  const mutatedPromptSpec = applyRetentionMutation(original.mnemora.promptSpec);
  const ctx: Ctx = { tenantId: `${tenantPrefix}-retention-mutation-mutated` };
  const mutatedResponse = await llmProvider.complete(ctx, mutatedPromptSpec);
  const mutatedVerdict = gradeAnswer(mutatedResponse.content, answerCase.expected);

  const groundTurnTexts = answerCase.grounds.turnIndex.map((i) => {
    const turn = answerCase.conversation[i];
    if (turn === undefined) {
      throw new Error(
        `recordRetentionMutationPositiveControl: grounds.turnIndex=${i} が conversation の範囲外`,
      );
    }
    return turn.text;
  });
  const mutatedJudgement = await judgeAnswer(judgeLLMProvider, ctx, {
    question: answerCase.question,
    expectedKind: answerCase.expected.kind,
    rationale: answerCase.grounds.rationale,
    groundTurnTexts,
    answer: mutatedResponse.content,
  });

  return {
    caseId: answerCase.id,
    originalVerdict: original.mnemora.verdict,
    // `runAnswerCase` は judge を必ず走らせるので、非 null アサーションは安全。
    originalJudgement: original.mnemora.judgement!,
    mutatedAnswer: mutatedResponse.content,
    mutatedVerdict,
    mutatedJudgement,
  };
}
