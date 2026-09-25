import { describe, expect, it } from "vitest";
import type { RecalledMemory, RecallResult } from "@mnemora/core";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import type { CaseMaterial, MaterialMemoryLine } from "../answer-trials-material.js";
import { loadAnswerTrialsMaterial } from "../answer-trials-material.js";
import { buildMnemoraPrompt } from "../mnemora-path.js";
import {
  RENDERERS,
  RENDER_NAMES,
  digestOnlyRenderer,
  getRenderer,
  isRenderName,
  orderLegendRenderer,
  recordedRenderer,
} from "../answer-trials-render.js";

/**
 * `answer-trials-render.ts` の単体試験。**DB 不要・鍵不要**——実カセットを読んで
 * `recordedRenderer` が原文と完全一致することを確かめる（Issue #705 完了条件）。
 */

describe("レジストリ", () => {
  it("RENDER_NAMES は recorded・digest-only・order-legend の3つ（ADR 0304、採らなかった order-sorted/digest-order-legend は外す）", () => {
    expect(RENDER_NAMES).toEqual(["recorded", "digest-only", "order-legend"]);
  });

  it("isRenderName / getRenderer", () => {
    expect(isRenderName("recorded")).toBe(true);
    expect(isRenderName("digest-only")).toBe(true);
    expect(isRenderName("order-legend")).toBe(true);
    expect(isRenderName("order-sorted")).toBe(false);
    expect(isRenderName("digest-order-legend")).toBe(false);
    expect(isRenderName("nonsense")).toBe(false);
    expect(getRenderer("recorded")).toBe(RENDERERS.recorded);
    expect(getRenderer("digest-only")).toBe(RENDERERS["digest-only"]);
    expect(getRenderer("order-legend")).toBe(RENDERERS["order-legend"]);
  });
});

describe("recordedRenderer(実カセット、dev 6件全部)", () => {
  const material = loadAnswerTrialsMaterial();

  it.each(ANSWER_CASE_SET_DEV.map((c) => c.id))(
    "%s: 再構成した内容がカセットの原文と完全一致する",
    (caseId) => {
      const m = material.cases.find((c) => c.caseId === caseId);
      expect(m).toBeDefined();
      const rendered = recordedRenderer.renderUserContent(m as CaseMaterial);
      expect(rendered).toBe((m as CaseMaterial).rawContent);
    },
  );
});

describe("digestOnlyRenderer", () => {
  it("由来等のタグを一切付けず、digest 行 + 索引行 + 質問だけを出す", () => {
    const material: CaseMaterial = {
      caseId: "x",
      question: "質問文?",
      system: "システム文",
      totalInScope: 2,
      presented: 2,
      lines: [
        { provenanceKind: "stated", subject: "なし", digest: "本文A" },
        { provenanceKind: "stated", subject: "なし", digest: "本文B" },
      ],
      rawContent: "(無視される。digest-only は rawContent と一致しなくてよい)",
      fingerprint: "dummy",
    };
    const rendered = digestOnlyRenderer.renderUserContent(material);
    expect(rendered).toBe(
      "- 本文A\n- 本文B\n(索引: スコープ内 2 件のうち 2 件を提示)\n\n質問: 質問文?",
    );
  });

  it("記憶0件のケースは索引行のみ+質問", () => {
    const material: CaseMaterial = {
      caseId: "x",
      question: "質問文?",
      system: "システム文",
      totalInScope: 3,
      presented: 0,
      lines: [],
      rawContent: "",
      fingerprint: "dummy",
    };
    const rendered = digestOnlyRenderer.renderUserContent(material);
    expect(rendered).toBe("(索引: スコープ内 3 件のうち 0 件を提示)\n\n質問: 質問文?");
  });
});

describe("変異試験(c): recordedRenderer の一致検査を外すと通ってしまうはずの入力で、いまは例外になることを確かめる", () => {
  it("material.lines を壊す(digest を書き換える)と、recordedRenderer は再構成の不一致を検出して例外を投げる", () => {
    const material = loadAnswerTrialsMaterial();
    const original = material.cases.find((c) => c.caseId === "pref-tea-over-coffee");
    expect(original).toBeDefined();
    const corrupted: CaseMaterial = {
      ...(original as CaseMaterial),
      lines: (original as CaseMaterial).lines.map((l, i) =>
        i === 0 ? { ...l, digest: `${l.digest}(改ざん)` } : l,
      ),
    };
    expect(() => recordedRenderer.renderUserContent(corrupted)).toThrow(/一致しない/);
  });

  it("正しい material のままなら例外にならない(陽性対照 — 上の検査が『何にでも』落ちているのではないことの確認)", () => {
    const material = loadAnswerTrialsMaterial();
    const original = material.cases.find((c) => c.caseId === "pref-tea-over-coffee");
    expect(original).toBeDefined();
    expect(() => recordedRenderer.renderUserContent(original as CaseMaterial)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// orderLegendRenderer と、本番の buildMnemoraPrompt（mnemora-path.ts）の一致検査
// （ADR 0304、マネージャー依頼「同じ材料から組んだ RecallResult を渡した
// buildMnemoraPrompt の出力と一致することを検査するテストを足す」への回答）。
// ---------------------------------------------------------------------------

/** `answer-bench.ts`/`answer-trials-material.ts` と同じ形。同上の理由で複製する。 */
function questionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/** `recordedOrder`（1始まりの順位）を、単調増加する `Date` へ機械的に写す基準時刻。 */
const RECORDED_AT_BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * {@link MaterialMemoryLine} から `RecalledMemory` を再構成する（parity 検査専用）。
 *
 * 🔴 **組める範囲の限界**: `contradiction`（矛盾候補）は再構成できない——
 * `renderRecalledMemoryLine`（`mnemora-path.ts`）は相手の `memoryId` ではなく
 * 相手の digest 本文を埋め込むため（ADR 0295 決定6）、パースし戻した文字列からは
 * 相手の `memoryId` が分からない。dev 6件のカセットにはそもそも矛盾候補を持つ行が
 * 1件も無い（【実測】`grep -c '矛盾候補' examples/chat/cassettes/answer.json` は
 * `0`、dev・eval 全12ケース通して）ため、この検査ではその行に当たったら
 * 例外にして気づけるようにするだけで、実際には dev 6件のどれも例外に落ちない。
 *
 * `score`（`ScoreBreakdown`）は描画に一切使われない（`renderRecalledMemoryLine` は
 * `m.score` を読まない）ため、固定のダミー値で埋める。`retrievedVia` も同様に
 * 描画へ影響しない（矛盾候補が無い限り）ため `"ann"` で固定する。
 */
function materialLineToRecalledMemory(line: MaterialMemoryLine, index: number): RecalledMemory {
  if (line.contradiction !== undefined) {
    throw new Error(
      "materialLineToRecalledMemory: 矛盾候補（contradiction）を持つ行は、相手の " +
        "memoryId をテキストから復元できないため、RecallResult へ再構成できない " +
        "（ADR 0304「組めない部分」）。",
    );
  }
  const recordedAt =
    line.recordedOrder !== undefined
      ? new Date(RECORDED_AT_BASE_MS + line.recordedOrder * 1000)
      : undefined;
  const occurredAt =
    line.occurredAt === undefined
      ? undefined
      : line.occurredAt === "不明"
        ? null
        : new Date(line.occurredAt);
  return {
    memoryId: `parity-${index}`,
    digest: line.digest,
    retrievedVia: "ann",
    provenanceKind: line.provenanceKind as RecalledMemory["provenanceKind"],
    speaker: line.speaker ?? null,
    subjectId: line.subject === "なし" ? null : line.subject,
    score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
    ...(recordedAt !== undefined ? { recordedAt } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

function materialToRecallResult(material: CaseMaterial): RecallResult {
  const memories = material.lines.map((l, i) => materialLineToRecalledMemory(l, i));
  return {
    recallId: "parity-recall",
    memories,
    omitted: [],
    index: { groups: [], totalInScope: material.totalInScope, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

describe(
  "orderLegendRenderer と buildMnemoraPrompt の一致（同じ材料から組んだ RecallResult。ADR 0304、" +
    "マネージャー依頼「描画の出力が、同じ材料から組んだ RecallResult を渡した buildMnemoraPrompt の" +
    "出力と一致することを検査する」への回答）",
  () => {
    const material = loadAnswerTrialsMaterial();

    it.each(ANSWER_CASE_SET_DEV.map((c) => c.id))(
      "%s: order-legend レジストリの出力 === 同じ材料から組んだ RecallResult を渡した buildMnemoraPrompt の出力 + 質問",
      (caseId) => {
        const m = material.cases.find((c) => c.caseId === caseId);
        expect(m).toBeDefined();
        const caseMaterial = m as CaseMaterial;
        const recall = materialToRecallResult(caseMaterial);
        const expected = `${buildMnemoraPrompt(recall)}${questionSuffix(caseMaterial.question)}`;
        const actual = orderLegendRenderer.renderUserContent(caseMaterial);
        expect(actual).toBe(expected);
      },
    );

    it("🔴 組めない部分: 矛盾候補を持つ行では RecallResult を再構成できない（dev 6件はどれもこの行に当たらない）", () => {
      const withContradiction: CaseMaterial = {
        caseId: "x",
        question: "質問?",
        system: "システム文",
        totalInScope: 2,
        presented: 2,
        lines: [
          {
            provenanceKind: "stated",
            subject: "なし",
            contradiction: "「相手の digest」",
            digest: "本文",
          },
        ],
        rawContent: "",
        fingerprint: "dummy",
      };
      expect(() => materialToRecallResult(withContradiction)).toThrow(/矛盾候補/);
    });
  },
);
