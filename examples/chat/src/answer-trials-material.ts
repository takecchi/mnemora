import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ANSWER_CASE_SET_DEV } from "./answer-case-set.dev.js";
import { ORDER_LEGEND_LINE } from "./mnemora-path.js";

/**
 * 材料抽出器。DB・埋め込み・抽出・recall を一切呼ばない（import もしない）。
 * 記録済みカセットの1つのプロンプトだけを材料の唯一の情報源にする。別の記憶集合になりうる経路を
 * 構造的に持たないことで、「別の記憶集合どうしを比べて退行が消えたと誤判定する」事故を再発させない。
 */

/**
 * `renderRecalledMemoryLine` が描画した1行を構造へ戻したもの。「無い」と「不明」を型のレベルで潰さない。
 * タグそのものが無ければ `undefined`、タグの値が `"不明"`/`"なし"` ならその文字列を保持する。
 */
export interface MaterialMemoryLine {
  provenanceKind: string;
  speaker?: string;
  subject: string;
  contradiction?: string;
  basisLost?: true;
  recordedOrder?: number;
  occurredAt?: string;
  digest: string;
}

export interface CaseMaterial {
  caseId: string;
  question: string;
  system: string;
  totalInScope: number;
  presented: number;
  lines: MaterialMemoryLine[];
  /**
   * `rawContent` の本体が {@link ORDER_LEGEND_LINE} で始まっていたか。`lines` から再導出しない。
   * 旧・凍結カセット `answer.json` は `[記録順:N]` タグを持つが凡例行を持たず、再導出すると再構成検査が壊れる。
   */
  hasOrderLegend: boolean;
  rawContent: string;
  fingerprint: string;
}

export interface AnswerTrialsMaterialSet {
  cassettePath: string;
  cassetteSha256: string;
  cassetteRecordedAt: string;
  cases: CaseMaterial[];
}

/**
 * `answer-bench.ts` の `ANSWER_SYSTEM_PROMPT` と同じ文字列。あちらを import しない。
 * `answer-bench.ts` は DB を import しており、この module は DB を import しない。ずれは単体試験がソースの生テキストで検出する。
 */
const ANSWER_SYSTEM_PROMPT =
  "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

/** `answer-bench.ts` の `buildQuestionSuffix` と同じ形。同上の理由で複製する。 */
function questionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/**
 * `answer-retention-mutation.ts` の `RETENTION_MUTATION_REPLACEMENT` と同じ文字列。あちらを import しない（同上）。
 * カセットには、この文字列を含む陽性対照のプロンプトが1件混じる。材料抽出はそれを除外する。複製がずれると
 * 除外に失敗して候補が2件になり、例外として表面化する。
 */
const KNOWN_MUTATION_MARKERS: readonly string[] = ["[要約失敗。内容は保持していません]"];

export function defaultCassettePath(): string {
  return fileURLToPath(new URL("../cassettes/answer.json", import.meta.url));
}

interface CassetteLlmEntry {
  prompt: { system?: string; messages: { role: string; content: string }[] };
  value: { content: string };
}

interface CassetteShape {
  recordedAt?: string;
  llm: { model?: string; entries: Record<string, CassetteLlmEntry> };
}

function readCassette(cassettePath: string): { raw: string; parsed: CassetteShape } {
  let raw: string;
  try {
    raw = readFileSync(cassettePath, "utf8");
  } catch (error) {
    throw new Error(
      `loadAnswerTrialsMaterial: カセット（${cassettePath}）を読めなかった。原因: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `loadAnswerTrialsMaterial: カセット（${cassettePath}）の JSON が壊れている。原因: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const shape = parsed as Partial<CassetteShape> | null;
  if (
    shape === null ||
    typeof shape !== "object" ||
    shape.llm === undefined ||
    typeof shape.llm !== "object" ||
    shape.llm.entries === undefined
  ) {
    throw new Error(
      `loadAnswerTrialsMaterial: カセット（${cassettePath}）に想定した形（llm.entries）が無い。`,
    );
  }
  return { raw, parsed: shape as CassetteShape };
}

function takeBracket(s: string, tag: string): { value: string; rest: string } | undefined {
  const re = new RegExp(`^\\[${tag}:([^\\]]*)\\]`);
  const m = re.exec(s);
  if (!m) {
    return undefined;
  }
  return { value: m[1] ?? "", rest: s.slice(m[0].length) };
}

function stripLeadingSpace(s: string, context: string): string {
  if (!s.startsWith(" ")) {
    throw new Error(
      `parseMemoryLine: 欄の後ろに想定した区切りの空白が無い（${context}）。行: ${JSON.stringify(s)}`,
    );
  }
  return s.slice(1);
}

/** `renderRecalledMemoryLine` が描画した1行を {@link MaterialMemoryLine} へパースする。解析できない行は例外を投げ、黙って飛ばさない。 */
export function parseMemoryLine(line: string): MaterialMemoryLine {
  if (!line.startsWith("- ")) {
    throw new Error(`parseMemoryLine: 行が "- " で始まっていない: ${JSON.stringify(line)}`);
  }
  let rest = line.slice(2);

  const prov = takeBracket(rest, "由来");
  if (!prov) {
    throw new Error(`parseMemoryLine: [由来:...] タグが見つからない: ${JSON.stringify(line)}`);
  }
  rest = stripLeadingSpace(prov.rest, `[由来:${prov.value}] の直後、行: ${JSON.stringify(line)}`);

  let speaker: string | undefined;
  const spk = takeBracket(rest, "話者");
  if (spk) {
    speaker = spk.value;
    rest = stripLeadingSpace(spk.rest, `[話者:...] の直後、行: ${JSON.stringify(line)}`);
  }

  const subj = takeBracket(rest, "主題");
  if (!subj) {
    throw new Error(`parseMemoryLine: [主題:...] タグが見つからない: ${JSON.stringify(line)}`);
  }
  rest = stripLeadingSpace(subj.rest, `[主題:${subj.value}] の直後、行: ${JSON.stringify(line)}`);

  let contradiction: string | undefined;
  const contra = takeBracket(rest, "矛盾候補");
  if (contra) {
    contradiction = contra.value;
    rest = stripLeadingSpace(contra.rest, `[矛盾候補:...] の直後、行: ${JSON.stringify(line)}`);
  }

  let basisLost: true | undefined;
  const basis = takeBracket(rest, "根拠");
  if (basis) {
    // 描画側が出す値は1つだけ。ほかの値は描画の形が変わったのに追従していないしるしなので、黙って受けずに止める。
    if (basis.value !== "失われた") {
      throw new Error(
        `parseMemoryLine: [根拠:...] の値が想定外（「失われた」だけを想定）: ${JSON.stringify(basis.value)}`,
      );
    }
    basisLost = true;
    rest = stripLeadingSpace(basis.rest, `[根拠:...] の直後、行: ${JSON.stringify(line)}`);
  }

  let recordedOrder: number | undefined;
  const rec = takeBracket(rest, "記録順");
  if (rec) {
    const n = Number(rec.value);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `parseMemoryLine: [記録順:...] の値が正の整数ではない: ${JSON.stringify(rec.value)}`,
      );
    }
    recordedOrder = n;
    rest = stripLeadingSpace(rec.rest, `[記録順:...] の直後、行: ${JSON.stringify(line)}`);
  }

  let occurredAt: string | undefined;
  const occ = takeBracket(rest, "出来事時刻");
  if (occ) {
    occurredAt = occ.value;
    rest = stripLeadingSpace(occ.rest, `[出来事時刻:...] の直後、行: ${JSON.stringify(line)}`);
  }

  if (rest.length === 0) {
    throw new Error(`parseMemoryLine: digest が空である: ${JSON.stringify(line)}`);
  }

  return {
    provenanceKind: prov.value,
    ...(speaker !== undefined ? { speaker } : {}),
    subject: subj.value,
    ...(contradiction !== undefined ? { contradiction } : {}),
    ...(basisLost !== undefined ? { basisLost } : {}),
    ...(recordedOrder !== undefined ? { recordedOrder } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    digest: rest,
  };
}

const INDEX_LINE_RE = /^\(索引: スコープ内 (\d+) 件のうち (\d+) 件を提示\)$/;

export function parseMnemoraPromptBody(body: string): {
  totalInScope: number;
  presented: number;
  lines: MaterialMemoryLine[];
  hasOrderLegend: boolean;
} {
  const rawLines = body.split("\n");
  const indexLineRaw = rawLines[rawLines.length - 1];
  if (indexLineRaw === undefined) {
    throw new Error("parseMnemoraPromptBody: 本体が空である。");
  }
  const m = INDEX_LINE_RE.exec(indexLineRaw);
  if (!m) {
    throw new Error(
      `parseMnemoraPromptBody: 最終行が索引行の形ではない: ${JSON.stringify(indexLineRaw)}`,
    );
  }
  const totalInScope = Number(m[1]);
  const presented = Number(m[2]);
  const hasOrderLegend = rawLines[0] === ORDER_LEGEND_LINE;
  const withoutLegend = hasOrderLegend ? rawLines.slice(1) : rawLines;
  const memoryLines = withoutLegend.slice(0, withoutLegend.length - 1);
  const lines = memoryLines.map((line) => parseMemoryLine(line));
  if (lines.length !== presented) {
    throw new Error(
      `parseMnemoraPromptBody: 索引行の提示件数（${presented}）と実際の行数（${lines.length}）が一致しない。`,
    );
  }
  return { totalInScope, presented, lines, hasOrderLegend };
}

function splitOffQuestionSuffix(content: string, question: string): string {
  const suffix = questionSuffix(question);
  if (!content.endsWith(suffix)) {
    throw new Error(
      `splitOffQuestionSuffix: content が期待した質問の接尾辞で終わっていない（question=${JSON.stringify(question)}）。`,
    );
  }
  return content.slice(0, content.length - suffix.length);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeFingerprint(
  material: Pick<
    CaseMaterial,
    "caseId" | "question" | "system" | "totalInScope" | "presented" | "lines"
  >,
): string {
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}

function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isMnemoraShapedContent(content: string): boolean {
  return (
    content.startsWith("- [由来:") ||
    content.startsWith("(索引:") ||
    content.startsWith(ORDER_LEGEND_LINE)
  );
}

function findMnemoraEntryContent(
  entries: Record<string, CassetteLlmEntry>,
  caseId: string,
  question: string,
): { key: string; system: string; content: string } {
  const suffix = questionSuffix(question);
  const candidates: { key: string; system: string; content: string }[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const system = entry.prompt.system;
    const message = entry.prompt.messages[0];
    if (system === undefined || message === undefined) {
      continue;
    }
    if (system !== ANSWER_SYSTEM_PROMPT) {
      continue;
    }
    const content = message.content;
    if (!content.endsWith(suffix)) {
      continue;
    }
    if (!isMnemoraShapedContent(content)) {
      continue; // naive 経路のプロンプト。除外する。
    }
    if (KNOWN_MUTATION_MARKERS.some((marker) => content.includes(marker))) {
      continue; // 陽性対照用の変異エントリ（answer-retention-mutation.ts）。除外する。
    }
    candidates.push({ key, system, content });
  }
  if (candidates.length === 0) {
    throw new Error(
      `findMnemoraEntryContent: case "${caseId}"（question=${JSON.stringify(question)}）に対応する` +
        "記憶経路の回答プロンプトがカセットに見つからない。対応づけられない dev ケースは黙って飛ばさない。",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `findMnemoraEntryContent: case "${caseId}"（question=${JSON.stringify(question)}）が複数` +
        `（${candidates.length}件: ${candidates.map((c) => c.key).join(", ")}）に当たった。` +
        "曖昧なまま材料にしない——既知の除外条件（naive 形式・既知の変異マーカー）を見直すこと。",
    );
  }
  const only = candidates[0];
  if (only === undefined) {
    throw new Error(
      "findMnemoraEntryContent: 到達しないはずの分岐（candidates.length===1のはず）。",
    );
  }
  return only;
}

function buildCaseMaterial(
  entries: Record<string, CassetteLlmEntry>,
  caseId: string,
  question: string,
): CaseMaterial {
  const found = findMnemoraEntryContent(entries, caseId, question);
  const body = splitOffQuestionSuffix(found.content, question);
  const { totalInScope, presented, lines, hasOrderLegend } = parseMnemoraPromptBody(body);
  const fingerprint = computeFingerprint({
    caseId,
    question,
    system: found.system,
    totalInScope,
    presented,
    lines,
  });
  return {
    caseId,
    question,
    system: found.system,
    totalInScope,
    presented,
    lines,
    hasOrderLegend,
    rawContent: found.content,
    fingerprint,
  };
}

export function loadAnswerTrialsMaterial(
  cassettePath: string = defaultCassettePath(),
): AnswerTrialsMaterialSet {
  const { raw, parsed } = readCassette(cassettePath);
  const cassetteSha256 = sha256OfText(raw);
  const cassetteRecordedAt = parsed.recordedAt ?? "";
  const cases = ANSWER_CASE_SET_DEV.map((c) =>
    buildCaseMaterial(parsed.llm.entries, c.id, c.question),
  );
  return { cassettePath, cassetteSha256, cassetteRecordedAt, cases };
}
