import { describe, expect, it } from "vitest";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import type { CaseMaterial } from "../answer-trials-material.js";
import { loadAnswerTrialsMaterial } from "../answer-trials-material.js";
import {
  RENDERERS,
  RENDER_NAMES,
  digestOnlyRenderer,
  getRenderer,
  isRenderName,
  recordedRenderer,
} from "../answer-trials-render.js";

/**
 * `answer-trials-render.ts` の単体試験。**DB 不要・鍵不要**——実カセットを読んで
 * `recordedRenderer` が原文と完全一致することを確かめる（Issue #705 完了条件）。
 */

describe("レジストリ", () => {
  it("RENDER_NAMES は recorded と digest-only の2つ", () => {
    expect(RENDER_NAMES).toEqual(["recorded", "digest-only"]);
  });

  it("isRenderName / getRenderer", () => {
    expect(isRenderName("recorded")).toBe(true);
    expect(isRenderName("digest-only")).toBe(true);
    expect(isRenderName("nonsense")).toBe(false);
    expect(getRenderer("recorded")).toBe(RENDERERS.recorded);
    expect(getRenderer("digest-only")).toBe(RENDERERS["digest-only"]);
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
