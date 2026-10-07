/** 門にするのは狭い窓（帰属の直後に鉤括弧）だけ。広い窓は偽陽性率に上限を置けないので報告に留める（ADR 0223 決定3 / ADR 0254）。 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorExistsInTarget } from "../adr-citation-lib.mjs";
import {
  findNarrowAgentsMdQuotes,
  findWideAgentsMdQuotes,
  quoteExistsInAgentsMd,
} from "../agents-md-quote-attribution-lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_MD = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
const DECISIONS = path.join(REPO_ROOT, "docs/decisions");
const CORRECTIONS = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "scripts/agents-md-quote-corrections.json"), "utf8"),
);

describe("引用の取り出し（入れ子の鉤括弧に対応する）", () => {
  it("帰属の直後の鉤括弧を取り、内側の『』では切らない", () => {
    const text = "これは `AGENTS.md`「⚠ 機械には『検出』まで」に従う。";
    expect(findNarrowAgentsMdQuotes(text)).toEqual([{ quote: "⚠ 機械には『検出』まで" }]);
  });

  it("行送りで `AGENTS.md` と鉤括弧が割れていても拾う", () => {
    const text = "これは `AGENTS.md`\n「⚠ 数を、道具と生成物に焼き込まない」に従う。";
    expect(findNarrowAgentsMdQuotes(text)).toEqual([
      { quote: "⚠ 数を、道具と生成物に焼き込まない" },
    ]);
  });

  it("帰属から離れた鉤括弧は、狭い窓には入れない（門を広げない）", () => {
    const text =
      "`AGENTS.md`「⚠ 数を」に照らすと、同じ節が明記する通り「一覧そのものを持つ」は許容。";
    expect(findNarrowAgentsMdQuotes(text)).toEqual([{ quote: "⚠ 数を" }]);
    expect(findWideAgentsMdQuotes(text)).toEqual([{ quote: "一覧そのものを持つ" }]);
  });
});

describe("⭐ 陽性対照 —— 既存の `anchorExistsInTarget` が落とす形を、この歯は捕まえる", () => {
  const target =
    "#### 🔴 線は引けない — [ADR 0178](./docs/decisions/0178-public-api-surface-gate.md) が反例";
  const quote = "🔴 線は引けない — ADR 0178 が反例";

  it("⭕ 既存もリンクを外して当てるので「在る」と判定する", () => {
    expect(anchorExistsInTarget(quote, target)).toBe(true);
  });

  it("⭕ この歯は段1（既存）で当てる", () => {
    expect(quoteExistsInAgentsMd(quote, target)).toEqual({ exists: true, stage: 1 });
  });

  it("⭕ 入れ子作法で括弧が変わった形も当たる（原典 `「検出」` / 引用 `『検出』`）", () => {
    const heading = "### ⚠ 機械には「検出」まで — 確定と書き込みは人に残す";
    expect(anchorExistsInTarget("⚠ 機械には『検出』まで", heading)).toBe(false);
    expect(quoteExistsInAgentsMd("⚠ 機械には『検出』まで", heading).exists).toBe(true);
  });

  it("⛔ 原典に本当に無い文は、どの段でも当たらない", () => {
    expect(quoteExistsInAgentsMd("ADR は書き換えず追記して積む", AGENTS_MD)).toEqual({
      exists: false,
      stage: 0,
    });
  });
});

function readAdrFiles() {
  return readdirSync(DECISIONS)
    .filter((name) => /^\d{4}.*\.md$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(DECISIONS, name), "utf8") }));
}

const declared = new Set(CORRECTIONS.corrections.map((c) => `${c.file}\t${c.quote}`));

describe("門: ADR が `AGENTS.md` を括って引いた文は、いまの `AGENTS.md` に実在する", () => {
  it("狭い窓で拾った引用が、全部 `AGENTS.md` に実在する（宣言済みの既知分を除く）", () => {
    const missing = [];
    for (const { name, text } of readAdrFiles()) {
      for (const { quote } of findNarrowAgentsMdQuotes(text)) {
        if (quoteExistsInAgentsMd(quote, AGENTS_MD).exists) continue;
        if (declared.has(`${name}\t${quote}`)) continue;
        missing.push(`${name}「${quote}」`);
      }
    }
    expect(
      missing,
      [
        "🔴 `AGENTS.md` の言明として括って引かれている文が、いまの `AGENTS.md` に見つかりません。",
        "⛔ ADR の本文は書き換えないこと（当時の記録である）——末尾に訂正の節を追記し、",
        "   正しい帰属（多くは別の ADR）を書くこと。訂正を書いたら",
        "   `scripts/agents-md-quote-corrections.json` にその住所を宣言すること。",
        "⚠ この歯は「いまの AGENTS.md に在るか」しか見ていない。意味が合っているかは見ていない。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⛔ 広い窓は門にしない —— 拾えた件数を記録するだけ（偽陽性に上限を置けないため）", () => {
    const wide = readAdrFiles().flatMap(({ name, text }) =>
      findWideAgentsMdQuotes(text)
        .filter(({ quote }) => !quoteExistsInAgentsMd(quote, AGENTS_MD).exists)
        .map(({ quote }) => `${name}「${quote}」`),
    );
    expect(Array.isArray(wide)).toBe(true);
  });
});

/** 宣言と現物の両方を実行時に取る。住所だけを持つと、訂正の節が消えても宣言が残って緑のままになる。 */
describe("宣言ファイルの住所も、実行時に当てる", () => {
  const readCorrected = (c) => readFileSync(path.join(REPO_ROOT, c.correctedIn.file), "utf8");

  it("`correctedIn.file` が実在し、`correctedIn.anchor` がその中に実在する", () => {
    const broken = CORRECTIONS.corrections
      .filter((c) => !anchorExistsInTarget(c.correctedIn.anchor, readCorrected(c)))
      .map((c) => `${c.correctedIn.file} に「${c.correctedIn.anchor}」が無い`);
    expect(
      broken,
      [
        "🔴 宣言ファイルが指す訂正の住所が、現物に見つかりません。",
        "⟹ 訂正の節が消えたか、改名されたか、宣言のほうが古いかのどれかです。",
        "⛔ どちらなのかは機械には分かりません——人が見て、宣言か訂正のどちらかを直してください。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⭐ 陽性対照: 存在しない住所を宣言したら赤くなる", () => {
    const fake = {
      correctedIn: {
        file: "docs/decisions/0121-bench-baselines-from-ci-artifacts.md",
        anchor: "⚠ 訂正（1970-01-01）: この節は存在しない",
      },
    };
    expect(anchorExistsInTarget(fake.correctedIn.anchor, readCorrected(fake))).toBe(false);
  });

  it("⛔ 余分な宣言を残さない —— 宣言した引用は、実際に原典に無いものだけである", () => {
    const stale = CORRECTIONS.corrections
      .filter((c) => quoteExistsInAgentsMd(c.quote, AGENTS_MD).exists)
      .map((c) => `${c.file}「${c.quote}」は、いまの AGENTS.md に実在する`);
    expect(
      stale,
      "🔴 もう腐っていない引用が宣言に残っています（`AGENTS.md` 側が変わった可能性）。宣言から外してください。",
    ).toEqual([]);
  });
});
