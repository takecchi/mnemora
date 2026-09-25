import type { CaseMaterial, MaterialMemoryLine } from "./answer-trials-material.js";

/**
 * Issue #705 / ADR 0301 の描画器。`answer-trials-material.ts` が組んだ
 * {@link CaseMaterial}（1つの記憶集合）を、A/B 2通りのプロンプト文字列へ描画する。
 *
 * ⭐ **A/B は同じ `CaseMaterial` を読むだけである。** 別の記憶集合を取り直すことは
 * 構造的にできない——`CaseMaterial` 以外の入力（DB・recall 等）を取らない。
 */

export type RenderName = "recorded" | "digest-only";

export interface Renderer {
  readonly name: RenderName;
  /** `complete()` へ渡す `messages[0].content` に相当する文字列（本体 + 質問）を作る。 */
  renderUserContent(material: CaseMaterial): string;
}

/** `answer-bench.ts` の `buildQuestionSuffix` と同じ形。`answer-trials-material.ts` と同じ理由で複製する。 */
function questionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

function indexLine(material: Pick<CaseMaterial, "totalInScope" | "presented">): string {
  return `(索引: スコープ内 ${material.totalInScope} 件のうち ${material.presented} 件を提示)`;
}

function joinBody(digestLines: string, index: string): string {
  return [digestLines, index].filter((s) => s.length > 0).join("\n");
}

// ---------------------------------------------------------------------------
// 描画 A: recorded — `renderRecalledMemoryLine`（mnemora-path.ts）と同じ形を、
// 構造化した材料から再構成する。
// ---------------------------------------------------------------------------

/** `mnemora-path.ts` の `renderRecalledMemoryLine` と同じ欄順序で1行を組み立てる。 */
function renderLineAsRecorded(line: MaterialMemoryLine): string {
  const segments = [
    `[由来:${line.provenanceKind}]`,
    line.speaker !== undefined ? `[話者:${line.speaker}]` : undefined,
    `[主題:${line.subject}]`,
    line.contradiction !== undefined ? `[矛盾候補:${line.contradiction}]` : undefined,
    line.recordedOrder !== undefined ? `[記録順:${line.recordedOrder}]` : undefined,
    line.occurredAt !== undefined ? `[出来事時刻:${line.occurredAt}]` : undefined,
  ].filter((s): s is string => s !== undefined);
  return `- ${segments.join(" ")} ${line.digest}`;
}

function renderBodyAsRecorded(material: CaseMaterial): string {
  const digestLines = material.lines.map((l) => renderLineAsRecorded(l)).join("\n");
  return joinBody(digestLines, indexLine(material));
}

/**
 * 描画 A（`recorded`）。**再構成した内容が、カセットに記録された原文と完全に一致することを
 * 毎回検査する**——ずれたら例外（Issue #705 完了条件・変異試験(c)の対象）。
 *
 * この検査があることで、`MaterialMemoryLine` のパース・再構成のどちらかに欠陥があっても、
 * 「材料が壊れているのに気づかず走らせ続ける」ことができない。
 */
export const recordedRenderer: Renderer = {
  name: "recorded",
  renderUserContent(material: CaseMaterial): string {
    const body = renderBodyAsRecorded(material);
    const reconstructed = `${body}${questionSuffix(material.question)}`;
    if (reconstructed !== material.rawContent) {
      throw new Error(
        `recordedRenderer: 再構成した内容がカセットの原文と一致しない（case=${material.caseId}）。\n` +
          `--- 再構成 ---\n${reconstructed}\n--- 原文 ---\n${material.rawContent}`,
      );
    }
    return reconstructed;
  },
};

// ---------------------------------------------------------------------------
// 描画 B: digest-only — 由来等のタグを一切付けない（Issue #691 以前の描画、
// ADR 0295 追記2 の「digest のみ」列と同じ形）。
// ---------------------------------------------------------------------------

export const digestOnlyRenderer: Renderer = {
  name: "digest-only",
  renderUserContent(material: CaseMaterial): string {
    const digestLines = material.lines.map((l) => `- ${l.digest}`).join("\n");
    const body = joinBody(digestLines, indexLine(material));
    return `${body}${questionSuffix(material.question)}`;
  },
};

export const RENDERERS: Readonly<Record<RenderName, Renderer>> = {
  recorded: recordedRenderer,
  "digest-only": digestOnlyRenderer,
};

export const RENDER_NAMES: readonly RenderName[] = ["recorded", "digest-only"];

export function isRenderName(value: string): value is RenderName {
  return (RENDER_NAMES as readonly string[]).includes(value);
}

export function getRenderer(name: RenderName): Renderer {
  return RENDERERS[name];
}
