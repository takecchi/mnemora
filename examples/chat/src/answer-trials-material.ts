import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ANSWER_CASE_SET_DEV } from "./answer-case-set.dev.js";

/**
 * Issue #705 / ADR 0301 の材料抽出器。
 *
 * 🔴 **この module は DB・埋め込み・抽出・recall を一切呼ばない（import もしない）。**
 * `examples/chat/cassettes/answer.json`（`record answer` が実 API で記録した既存のカセット、
 * ADR 0051）を読むだけで、`answer-case-set.dev.ts` の dev 6件それぞれに対応する
 * mnemora 経路の回答プロンプト（`mnemora-path.ts` の `buildMnemoraPrompt` が組んだもの）を
 * 見つけ、`renderRecalledMemoryLine` が描画した1行ずつのタグ付き文字列を、構造化した
 * `MaterialMemoryLine` へ**パースして戻す**。
 *
 * **なぜ recall をやり直さないのか（Issue #691 / ADR 0295 追記2 の見落としの再発防止）**:
 * ADR 0295 追記2 が明らかにした事故は、「対照Aと対照Bが同じ記憶集合の上で回っている」ことを
 * 器が確かめていなかったことだった——別の抽出・別の recall で得た記憶集合を比べて
 * 「退行は消えた」と誤判定した。この module が**カセットの中の1つの記録済みプロンプトだけを
 * 材料の唯一の情報源にする**のは、そもそも「別の記憶集合になりうる経路」（DB・埋め込み・抽出・
 * recall の再実行）を構造的に持たないことで、同じ事故を再発させないためである。
 */

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/**
 * `renderRecalledMemoryLine`（`mnemora-path.ts`）が描画した1行を構造へ戻したもの。
 *
 * 各欄の「無い」の表現:
 * - `speaker`: `provenanceKind !== "stated"` のときはタグそのものが無い ⟹ `undefined`。
 *   `stated` だが値が無いときはタグの値が文字通り `"不明"` になる（`speakerSegment` 参照）
 *   ——これは `undefined` にせず、そのまま文字列 `"不明"` として保持する。「無い」と
 *   「不明」を型のレベルで潰さない。
 * - `subject`: 常にタグが在る（`subjectSegment` は常に値を返す）。値が無ければ文字列
 *   `"なし"`。
 * - `contradiction`: 矛盾関係が無ければタグが無い ⟹ `undefined`。
 * - `recordedOrder`: `recordedAt` を渡さなかった要素はタグが無い ⟹ `undefined`。
 * - `occurredAt`: `occurredAt` が `undefined`（頼んでいない）ならタグが無い ⟹
 *   `undefined`。`null`（頼んだが無かった）なら文字列 `"不明"`。
 */
export interface MaterialMemoryLine {
  provenanceKind: string;
  speaker?: string;
  subject: string;
  contradiction?: string;
  recordedOrder?: number;
  occurredAt?: string;
  digest: string;
}

/** 1 dev ケース分の材料。 */
export interface CaseMaterial {
  caseId: string;
  question: string;
  /** カセットに記録された system 文（`ANSWER_SYSTEM_PROMPT` と一致するはず）。 */
  system: string;
  totalInScope: number;
  presented: number;
  lines: MaterialMemoryLine[];
  /** カセットに記録された、この case の mnemora 側 `messages[0].content` の原文そのまま。 */
  rawContent: string;
  /** 正規化した構造（`caseId`/`question`/`system`/`totalInScope`/`presented`/`lines`）の sha256。 */
  fingerprint: string;
}

export interface AnswerTrialsMaterialSet {
  cassettePath: string;
  /** カセットファイル全体（生のテキスト）の sha256。 */
  cassetteSha256: string;
  /** カセットの `recordedAt`（現物の値をそのまま通す。焼き直さない）。 */
  cassetteRecordedAt: string;
  /** `answer-case-set.dev.ts` と同じ順序。 */
  cases: CaseMaterial[];
}

// ---------------------------------------------------------------------------
// 既知の定数（answer-bench.ts / answer-retention-mutation.ts の値を、DB を import せずに
// 独立して複製したもの——理由は下のコメント参照）
// ---------------------------------------------------------------------------

/**
 * `answer-bench.ts` の `ANSWER_SYSTEM_PROMPT` と同じ文字列。**あちらを import しない**
 * ——`answer-bench.ts` は `@mnemora/postgres`（DB）を import しており、この module は
 * DB を一切 import しない規律を持つ（本ファイル冒頭）。ずれた場合は
 * `__tests__/answer-trials-material.test.ts` がソースの生テキストを直接読んで一致を
 * 確認する（import を使わない自己整合性の検査、下記テスト参照）。
 */
const ANSWER_SYSTEM_PROMPT =
  "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

/**
 * `answer-bench.ts` の `buildQuestionSuffix` と同じ形（`"\n\n質問: " + question`）。
 * 同上の理由で複製する。
 */
function questionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/**
 * `answer-retention-mutation.ts` の `RETENTION_MUTATION_REPLACEMENT` と同じ文字列。
 * **あちらを import しない**（同上の理由——`answer-retention-mutation.ts` は
 * `answer-bench.ts` 経由で DB を import する）。
 *
 * カセットには、この文字列を含む「陽性対照」用の mnemora プロンプトが1件混じっている
 * （`pref-tea-over-coffee` の digest を意図的に壊した変異、`recordRetentionMutationPositiveControl`
 * が記録する）。材料抽出はこれを**除外する**——除外できなければ「複数に当たった」例外に
 * 落ちる（下記 `findMnemoraEntryContent` 参照）。ずれ（この文字列が変わったのに複製し忘れる）
 * を黙って見逃さない——ずれた場合、除外に失敗して候補が2件になり、例外として表面化する。
 */
const KNOWN_MUTATION_MARKERS: readonly string[] = ["[要約失敗。内容は保持していません]"];

// ---------------------------------------------------------------------------
// カセットのパス・読み込み
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1行のパース（`renderRecalledMemoryLine` の逆変換）
// ---------------------------------------------------------------------------

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

/**
 * `renderRecalledMemoryLine` が描画した1行（先頭の `"- "` を含む）を
 * {@link MaterialMemoryLine} へパースする。欄の順序は由来 → 話者 → 主題 → 矛盾候補 →
 * 記録順 → 出来事時刻 → digest（`mnemora-path.ts` の同関数 docstring と同じ順序）。
 *
 * ⛔ **解析できない行は例外を投げる（黙って飛ばさない、Issue #705 の要求）。**
 */
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
    ...(recordedOrder !== undefined ? { recordedOrder } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    digest: rest,
  };
}

const INDEX_LINE_RE = /^\(索引: スコープ内 (\d+) 件のうち (\d+) 件を提示\)$/;

/**
 * `buildMnemoraPrompt` の出力（質問の接尾辞を含まない本体部分）をパースする。
 * 最後の行が索引行、それより前の行があれば1行ずつ `parseMemoryLine` へ渡す。
 */
export function parseMnemoraPromptBody(body: string): {
  totalInScope: number;
  presented: number;
  lines: MaterialMemoryLine[];
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
  const memoryLines = rawLines.slice(0, rawLines.length - 1);
  const lines = memoryLines.map((line) => parseMemoryLine(line));
  if (lines.length !== presented) {
    throw new Error(
      `parseMnemoraPromptBody: 索引行の提示件数（${presented}）と実際の行数（${lines.length}）が一致しない。`,
    );
  }
  return { totalInScope, presented, lines };
}

/**
 * カセットの1エントリの `content`（本体 + 質問の接尾辞）から、本体部分だけを切り出す。
 * `question` に対応する接尾辞（`"\n\n質問: " + question`）で終わっていなければ例外。
 */
function splitOffQuestionSuffix(content: string, question: string): string {
  const suffix = questionSuffix(question);
  if (!content.endsWith(suffix)) {
    throw new Error(
      `splitOffQuestionSuffix: content が期待した質問の接尾辞で終わっていない（question=${JSON.stringify(question)}）。`,
    );
  }
  return content.slice(0, content.length - suffix.length);
}

// ---------------------------------------------------------------------------
// 安定 JSON 化・指紋
// ---------------------------------------------------------------------------

/** キーをソートして再帰的に安定させた JSON 文字列を作る（オブジェクトの挿入順に依存しない）。 */
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

// ---------------------------------------------------------------------------
// カセットからケース1件分を探す
// ---------------------------------------------------------------------------

function isMnemoraShapedContent(content: string): boolean {
  return content.startsWith("- [由来:") || content.startsWith("(索引:");
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
  const { totalInScope, presented, lines } = parseMnemoraPromptBody(body);
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
    rawContent: found.content,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * `examples/chat/cassettes/answer.json` から、dev 6件それぞれの mnemora 経路の
 * 回答プロンプトを読み、構造化した材料に戻す。
 *
 * ⛔ **DB・埋め込み・抽出・recall は一切呼ばない**（この module 自体、それらを import すら
 * していない——冒頭のコメント参照）。
 *
 * **対応づけられない dev ケース・複数に当たるケースは例外で止める。**
 * （`findMnemoraEntryContent` 参照。黙って飛ばさない、Issue #705 の要求。）
 */
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
