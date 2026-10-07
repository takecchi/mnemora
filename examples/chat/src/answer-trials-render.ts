import { ORDER_LEGEND_LINE } from "./mnemora-path.js";
import type { CaseMaterial, MaterialMemoryLine } from "./answer-trials-material.js";

/** `CaseMaterial`（1つの記憶集合）を A/B/C のプロンプト文字列へ描画する。`CaseMaterial` 以外（DB・recall 等）を入力に取らず、別の記憶集合を取り直せない。 */

export type RenderName = "recorded" | "digest-only" | "order-legend";

export interface Renderer {
  readonly name: RenderName;
  renderUserContent(material: CaseMaterial): string;
}

function questionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

function indexLine(material: Pick<CaseMaterial, "totalInScope" | "presented">): string {
  return `(索引: スコープ内 ${material.totalInScope} 件のうち ${material.presented} 件を提示)`;
}

function joinBody(digestLines: string, index: string): string {
  return [digestLines, index].filter((s) => s.length > 0).join("\n");
}

function renderLineAsRecorded(line: MaterialMemoryLine): string {
  const segments = [
    `[由来:${line.provenanceKind}]`,
    line.speaker !== undefined ? `[話者:${line.speaker}]` : undefined,
    `[主題:${line.subject}]`,
    line.contradiction !== undefined ? `[矛盾候補:${line.contradiction}]` : undefined,
    line.basisLost === true ? "[根拠:失われた]" : undefined,
    line.recordedOrder !== undefined ? `[記録順:${line.recordedOrder}]` : undefined,
    line.occurredAt !== undefined ? `[出来事時刻:${line.occurredAt}]` : undefined,
  ].filter((s): s is string => s !== undefined);
  return `- ${segments.join(" ")} ${line.digest}`;
}

/**
 * `recorded` 描画は原文の凡例行の有無も再現する。`material.lines` から再導出しない。旧・凍結カセット `answer.json` は
 * `[記録順:N]` 行があっても凡例行を持たず、推測すると原文と食い違う。`material.hasOrderLegend` をそのまま使う。
 */
function renderBodyAsRecorded(material: CaseMaterial): string {
  const digestLines = material.lines.map((l) => renderLineAsRecorded(l)).join("\n");
  const head = material.hasOrderLegend ? `${ORDER_LEGEND_LINE}\n` : "";
  return `${head}${joinBody(digestLines, indexLine(material))}`;
}

/** 描画 A（`recorded`）。再構成した内容がカセットの原文と完全に一致することを毎回検査し、ずれたら例外にする。パースか再構成の欠陥を見逃さないため。 */
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

export const digestOnlyRenderer: Renderer = {
  name: "digest-only",
  renderUserContent(material: CaseMaterial): string {
    const digestLines = material.lines.map((l) => `- ${l.digest}`).join("\n");
    const body = joinBody(digestLines, indexLine(material));
    return `${body}${questionSuffix(material.question)}`;
  },
};

// 描画 C: order-legend。凡例文字列は `ORDER_LEGEND_LINE` を `mnemora-path.ts` から import して1箇所にする。
// 2箇所に手で複製すると、どちらかを直し忘れて静かにずれる。

function sortByRecordedOrder(lines: readonly MaterialMemoryLine[]): MaterialMemoryLine[] {
  const withOrder = lines.filter((l) => l.recordedOrder !== undefined);
  const without = lines.filter((l) => l.recordedOrder === undefined);
  return [
    ...[...withOrder].sort((a, b) => (a.recordedOrder ?? 0) - (b.recordedOrder ?? 0)),
    ...without,
  ];
}

export const orderLegendRenderer: Renderer = {
  name: "order-legend",
  renderUserContent(material: CaseMaterial): string {
    // `material.hasOrderLegend`（原文に凡例行があったか）とは別の判定。この描画は原文の形に関わらず、記録順を1件以上持てば常に凡例行を足す。
    const hasAnyRecordedOrder = material.lines.some((l) => l.recordedOrder !== undefined);
    const lines = sortByRecordedOrder(material.lines)
      .map((l) => renderLineAsRecorded(l))
      .join("\n");
    const head = hasAnyRecordedOrder ? `${ORDER_LEGEND_LINE}\n` : "";
    return `${head}${joinBody(lines, indexLine(material))}${questionSuffix(material.question)}`;
  },
};

export const RENDERERS: Readonly<Record<RenderName, Renderer>> = {
  recorded: recordedRenderer,
  "digest-only": digestOnlyRenderer,
  "order-legend": orderLegendRenderer,
};

export const RENDER_NAMES: readonly RenderName[] = ["recorded", "digest-only", "order-legend"];

export function isRenderName(value: string): value is RenderName {
  return (RENDER_NAMES as readonly string[]).includes(value);
}

export function getRenderer(name: RenderName): Renderer {
  return RENDERERS[name];
}
