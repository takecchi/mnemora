import type { Ctx, LLMProvider, PromptSpec } from "@mnemora/core";
import { OpenAILLMProvider } from "@mnemora/openai";
import type { AnswerCase, AnswerVerdict } from "./answer-case.js";
import { gradeAnswer } from "./answer-case.js";
import { ANSWER_CASE_SET_DEV } from "./answer-case-set.dev.js";
import type { AnswerTrialsMaterialSet, CaseMaterial } from "./answer-trials-material.js";
import { loadAnswerTrialsMaterial } from "./answer-trials-material.js";
import type { RenderName } from "./answer-trials-render.js";
import { RENDER_NAMES, getRenderer, isRenderName } from "./answer-trials-render.js";
import type { EnvLike } from "./providers.js";
import { OPENAI_EMBEDDING_MODEL, OPENAI_LLM_MODEL } from "./providers.js";
import { createUsageMeter } from "./usage-meter.js";

/**
 * 同じ記憶集合で回答生成を n 回試行し、正答数で見る器。1回の試行では揺れるケースの退行も改善も見えないため。
 *
 * CI の門にしない。手元で回す観測用の CLI で、`ci.yml` には配線しない。
 * 開発ケースのみを扱い、`ANSWER_CASE_SET_EVAL`（held-out）は参照しない。
 */

export const DEFAULT_ANSWER_TRIALS_N = 5;
export const DEFAULT_ANSWER_TRIALS_RENDERS: readonly RenderName[] = ["recorded", "digest-only"];

export function parseAnswerTrialsN(env: EnvLike): number {
  const raw = env.MNEMORA_ANSWER_TRIALS_N;
  if (raw === undefined || raw === "") {
    return DEFAULT_ANSWER_TRIALS_N;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `parseAnswerTrialsN: MNEMORA_ANSWER_TRIALS_N には正の整数を指定すること（実際: "${raw}"）。`,
    );
  }
  return n;
}

export function parseAnswerTrialsRenders(env: EnvLike): RenderName[] {
  const raw = env.MNEMORA_ANSWER_TRIALS_RENDERS;
  if (raw === undefined || raw === "") {
    return [...DEFAULT_ANSWER_TRIALS_RENDERS];
  }
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) {
    throw new Error("parseAnswerTrialsRenders: MNEMORA_ANSWER_TRIALS_RENDERS が空である。");
  }
  for (const name of names) {
    if (!isRenderName(name)) {
      throw new Error(
        `parseAnswerTrialsRenders: 未知の描画名 "${name}"（許すのは ${RENDER_NAMES.join(" / ")}）。`,
      );
    }
  }
  return names as RenderName[];
}

export interface CaseRenderStatic {
  renderName: RenderName;
  systemChars: number;
  userContentChars: number;
}

export interface CaseMaterialSummary {
  caseId: string;
  fingerprint: string;
  renders: CaseRenderStatic[];
}

export interface CaseRenderVerdicts {
  renderName: RenderName;
  n: number;
  passCount: number;
  failCount: number;
  indeterminateCount: number;
}

export interface CaseTrialResult {
  caseId: string;
  renders: CaseRenderVerdicts[];
}

interface AnswerTrialsResultBase {
  measuredAt: string;
  model: string;
  n: number;
  renders: RenderName[];
  cassettePath: string;
  cassetteSha256: string;
  cassetteRecordedAt: string;
  caseMaterials: CaseMaterialSummary[];
}

/** `temperature` は常にこの文字列。`OpenAILLMProvider.complete` が渡しておらず、実際の値は OpenAI 側の既定でこの器からは見えない。数値を捏造しない。 */
export const TEMPERATURE_UNSPECIFIED_LABEL = "provider既定（未指定）";

export interface AnswerTrialsEvaluated extends AnswerTrialsResultBase {
  evaluated: true;
  temperature: typeof TEMPERATURE_UNSPECIFIED_LABEL;
  caseResults: CaseTrialResult[];
  usage: { chatCalls: number; promptTokens: number; completionTokens: number };
  costUsd: { inputUsd: number; outputUsd: number; totalUsd: number };
}

export interface AnswerTrialsUnevaluated extends AnswerTrialsResultBase {
  evaluated: false;
  reason: "no-api-key";
}

export type AnswerTrialsResult = AnswerTrialsEvaluated | AnswerTrialsUnevaluated;

export interface RunAnswerTrialsOptions {
  env?: EnvLike;
  /** DI 用。テストがモック `LLMProvider` を注入する。渡した run は `OPENAI_API_KEY` の有無を見ず、`usage`/`costUsd` も計測しない（数値を捏造しない）。 */
  llmProvider?: LLMProvider;
  material?: AnswerTrialsMaterialSet;
  n?: number;
  renders?: RenderName[];
  now?: () => Date;
}

function buildCaseIndex(cases: readonly AnswerCase[]): ReadonlyMap<string, AnswerCase> {
  return new Map(cases.map((c) => [c.id, c] as const));
}

function staticSummaryFor(
  material: CaseMaterial,
  renders: readonly RenderName[],
): CaseMaterialSummary {
  return {
    caseId: material.caseId,
    fingerprint: material.fingerprint,
    renders: renders.map((renderName) => {
      const content = getRenderer(renderName).renderUserContent(material);
      return {
        renderName,
        systemChars: material.system.length,
        userContentChars: content.length,
      };
    }),
  };
}

/** 本体。`options.llmProvider` が無く `OPENAI_API_KEY` も無ければ、実 API を呼ばず `evaluated: false` を返す。`recorded` へ黙ってフォールバックしない（`digest-only` 描画はカセットに無い）。 */
export async function runAnswerTrials(
  options: RunAnswerTrialsOptions = {},
): Promise<AnswerTrialsResult> {
  const env = options.env ?? process.env;
  const n = options.n ?? parseAnswerTrialsN(env);
  const renders = options.renders ?? parseAnswerTrialsRenders(env);
  const material = options.material ?? loadAnswerTrialsMaterial();
  const now = options.now ?? (() => new Date());
  const measuredAt = now().toISOString();
  const caseIndex = buildCaseIndex(ANSWER_CASE_SET_DEV);

  const caseMaterials = material.cases.map((m) => staticSummaryFor(m, renders));

  const base = {
    measuredAt,
    model: OPENAI_LLM_MODEL,
    n,
    renders,
    cassettePath: material.cassettePath,
    cassetteSha256: material.cassetteSha256,
    cassetteRecordedAt: material.cassetteRecordedAt,
    caseMaterials,
  };

  let llmProvider = options.llmProvider;
  let meter: ReturnType<typeof createUsageMeter> | undefined;
  if (llmProvider === undefined) {
    if (!env.OPENAI_API_KEY) {
      return { ...base, evaluated: false, reason: "no-api-key" };
    }
    meter = createUsageMeter({
      apiKey: env.OPENAI_API_KEY,
      llmModel: OPENAI_LLM_MODEL,
      embeddingModel: OPENAI_EMBEDDING_MODEL,
    });
    llmProvider = new OpenAILLMProvider({
      apiKey: env.OPENAI_API_KEY,
      model: OPENAI_LLM_MODEL,
      client: meter.client,
    });
  }

  const caseResults: CaseTrialResult[] = [];
  for (const m of material.cases) {
    const answerCase = caseIndex.get(m.caseId);
    if (answerCase === undefined) {
      throw new Error(
        `runAnswerTrials: 材料の case "${m.caseId}" が ANSWER_CASE_SET_DEV に見つからない。`,
      );
    }
    const renderVerdicts: CaseRenderVerdicts[] = [];
    for (const renderName of renders) {
      const content = getRenderer(renderName).renderUserContent(m);
      const promptSpec: PromptSpec = {
        system: m.system,
        messages: [{ role: "user", content }],
      };
      const verdicts: AnswerVerdict[] = [];
      for (let i = 0; i < n; i += 1) {
        const ctx: Ctx = { tenantId: `answer-trials-${m.caseId}-${renderName}-${i}` };
        const response = await llmProvider.complete(ctx, promptSpec);
        verdicts.push(gradeAnswer(response.content, answerCase.expected));
      }
      renderVerdicts.push({
        renderName,
        n,
        passCount: verdicts.filter((v) => v === "pass").length,
        failCount: verdicts.filter((v) => v === "fail").length,
        indeterminateCount: verdicts.filter((v) => v === "indeterminate").length,
      });
    }
    caseResults.push({ caseId: m.caseId, renders: renderVerdicts });
  }

  const usage = meter
    ? (() => {
        const t = meter.totals();
        return {
          chatCalls: t.chatCalls,
          promptTokens: t.chatPromptTokens,
          completionTokens: t.chatCompletionTokens,
        };
      })()
    : { chatCalls: 0, promptTokens: 0, completionTokens: 0 };
  const costUsd = meter
    ? (() => {
        const c = meter.cost();
        return { inputUsd: c.llmInputUsd, outputUsd: c.llmOutputUsd, totalUsd: c.totalUsd };
      })()
    : { inputUsd: 0, outputUsd: 0, totalUsd: 0 };

  return {
    ...base,
    evaluated: true,
    temperature: TEMPERATURE_UNSPECIFIED_LABEL,
    caseResults,
    usage,
    costUsd,
  };
}

export function formatAnswerTrialsUnevaluatedNotice(): string {
  return (
    "🔴 未評価（実 API が無い）——OPENAI_API_KEY が環境に無いため、回答生成を一度も呼んでいない。\n" +
    "  カセットの再生（recorded provider）へは黙って倒れない——このケースセットの描画（特に\n" +
    "  digest-only）は記録されたことが無い入力であり、`recorded` は記録に無い入力を例外にする。"
  );
}

function formatVerdictCounts(v: CaseRenderVerdicts): string {
  return `pass=${v.passCount} fail=${v.failCount} indeterminate=${v.indeterminateCount} (n=${v.n})`;
}

export function formatAnswerTrialsReport(result: AnswerTrialsResult): string {
  const lines: string[] = [];
  lines.push("--- answer-trials（Issue #705） ---");
  lines.push(
    `model: ${result.model} / temperature: ${result.evaluated ? result.temperature : "（未評価のため不明）"}`,
  );
  lines.push(`n（試行回数）: ${result.n} / 描画: ${result.renders.join(", ")}`);
  lines.push(`cassette: ${result.cassettePath}`);
  lines.push(`cassette sha256: ${result.cassetteSha256}`);
  lines.push(`cassette recordedAt: ${result.cassetteRecordedAt}`);
  lines.push("");
  lines.push("ケースごとの材料指紋・プロンプト文字数:");
  for (const cm of result.caseMaterials) {
    lines.push(`  ${cm.caseId} (fingerprint=${cm.fingerprint.slice(0, 12)}…)`);
    for (const r of cm.renders) {
      lines.push(
        `    [${r.renderName}] systemChars=${r.systemChars} userContentChars=${r.userContentChars}`,
      );
    }
  }
  lines.push("");
  if (!result.evaluated) {
    lines.push(formatAnswerTrialsUnevaluatedNotice());
    return lines.join("\n");
  }
  lines.push("ケースごとの正答数（一次判定 gradeAnswer）:");
  for (const cr of result.caseResults) {
    lines.push(`  ${cr.caseId}`);
    for (const v of cr.renders) {
      lines.push(`    [${v.renderName}] ${formatVerdictCounts(v)}`);
    }
  }
  lines.push("");
  lines.push("--- OpenAI API 実測 ---");
  lines.push(
    `chat.completions.create: 呼び出し ${result.usage.chatCalls} 回 / ` +
      `prompt_tokens=${result.usage.promptTokens} / completion_tokens=${result.usage.completionTokens}`,
  );
  lines.push(
    "費用（usage-meter.ts の公開価格表による概算。OpenAI の請求 API から取得した実額ではない）: " +
      `input=$${result.costUsd.inputUsd.toFixed(6)} output=$${result.costUsd.outputUsd.toFixed(6)} ` +
      `合計=$${result.costUsd.totalUsd.toFixed(6)}`,
  );
  return lines.join("\n");
}
