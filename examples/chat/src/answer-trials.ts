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
 * Issue #705: 「同じ記憶集合で回答生成を n 回試行し、正答数（pass/fail/indeterminate の件数）で
 * 見る器」の本体。
 *
 * 🔴 **背景（ADR 0295 追記2）**: PR #698 は `schedule-change-meeting-day` を1回だけ試行して
 * ✅ を見た。同じ記憶集合で複数回試行すると 3/15 まで割れることが後で分かった——1回の試行では
 * 揺れるケースの退行も改善も見えない。この器は、**同じ記憶集合**（`answer-trials-material.ts`
 * がカセットから読む、DB・recall を一切やり直さない材料）に対して、描画 A/B を n 回ずつ回す。
 *
 * ⛔ **CI の門にしない**（Issue #705 の完了条件・#693 の線）。この器はあくまで手元で回す
 * 観測用の CLI であり、`.github/workflows/ci.yml` には配線しない（ADR 0300 決定）。
 *
 * ⛔ **開発ケースのみを扱う。** `ANSWER_CASE_SET_EVAL`（held-out）はこの module から一度も
 * 参照しない——`answer-trials-material.ts` が `ANSWER_CASE_SET_DEV` だけをカセットから
 * 引き当てる設計になっている（ADR 0300 決定「eval は今回は受け付けない」）。
 */

// ---------------------------------------------------------------------------
// n・描画順の既定と env からの読み取り
// ---------------------------------------------------------------------------

export const DEFAULT_ANSWER_TRIALS_N = 5;
export const DEFAULT_ANSWER_TRIALS_RENDERS: readonly RenderName[] = ["recorded", "digest-only"];

/** `MNEMORA_ANSWER_TRIALS_N`。未指定なら {@link DEFAULT_ANSWER_TRIALS_N}。正の整数以外は例外。 */
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

/**
 * `MNEMORA_ANSWER_TRIALS_RENDERS`（カンマ区切り）。未指定なら
 * {@link DEFAULT_ANSWER_TRIALS_RENDERS}（A=recorded, B=digest-only の順）。
 * 未知の描画名は例外（`parseModeOverride` と同じ作法、黙って無視しない）。
 */
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

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

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

/**
 * `temperature` は常にこの文字列——`OpenAILLMProvider.complete` が `temperature` を
 * 一切渡していない（`packages/openai/src/llm-provider.ts` 現物確認済み）ため、実際に
 * 使われる値は OpenAI 側の既定であり、この器からは見えない。**数値を捏造しない**
 * （AGENTS.md の一般規律の適用）。
 */
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
  /**
   * DI 用。テストがモック `LLMProvider` を注入するために使う。**これを渡した run は
   * `OPENAI_API_KEY` の有無を見ない**（未評価判定をバイパスする）——呼び出し側が
   * 明示的に provider を用意した以上、キーの有無で判定する理由が無い。この経路では
   * `usage`/`costUsd` を計測しない（自前で構築した `usage-meter` を経由しないため。
   * 数値を捏造しない——`usage`/`costUsd` は常に `{0,...}` ではなく、計測していないことを
   * 示す別の扱いにする。下記 `runAnswerTrials` 実装参照）。
   */
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

/**
 * 本体。**`options.llmProvider` が渡されなければ**、`options.env`（既定
 * `process.env`）の `OPENAI_API_KEY` を見る——無ければ実 API を一度も呼ばず、
 * `evaluated: false` を返す（黙った `recorded` へのフォールバックはしない。
 * カセットに無い入力なので——`digest-only` 描画は元より一度も記録されたことが無い）。
 */
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

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

/** `evaluated: false` のときに画面へ出す注記。`formatNoApiCallsNotice`（usage-meter.ts）と同じ規律。 */
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
