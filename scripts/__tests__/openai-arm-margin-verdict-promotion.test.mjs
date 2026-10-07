import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  decideMarginShadowVerdict,
  decideShadowVerdict,
} from "../openai-arm-summary-lib.mjs";

const CHAT_ROOT = fileURLToPath(new URL("../../examples/chat/", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, `file://${CHAT_ROOT}`), "utf8"));
}

const measurement = readJson("openai-margin-candidate-measurement.json");
const identifierBaseline = readJson("identifier-probe-baseline.openai.json");
const numeralBaseline = readJson("numeral-token-probe-baseline.openai.json");

const schemaByGroup = new Map(
  [...identifierBaseline.groups, ...numeralBaseline.groups].map((g) => [
    g.group,
    {
      label: g.label,
      llmMode: g.llmMode,
      embeddingMode: g.embeddingMode,
      embeddingSpace: g.embeddingSpace,
      haystackKind: g.haystackKind,
    },
  ]),
);

function toArmGroup(rawGroup) {
  const schema = schemaByGroup.get(rawGroup.group);
  if (!schema) {
    throw new Error(`schemaByGroup に ${rawGroup.group} が無い(基準値ファイルを見直すこと)`);
  }
  return {
    group: rawGroup.group,
    ...schema,
    mrrOverall: rawGroup.mrrOverall,
    hit1Count: rawGroup.hit1Count,
    hit10Count: rawGroup.hit10Count,
    probeCount: rawGroup.probeCount,
    probeMargins: rawGroup.probes.map((p) => ({ probeId: p.probeId, margin: p.margin })),
  };
}

const baselineGroups = measurement.baseline.groups.map(toArmGroup);

const FIXTURE_ROUND_INDEX = 4;
const measuredRound = measurement.perRound[FIXTURE_ROUND_INDEX];
const measuredGroups = measuredRound.groups.map(toArmGroup);

const IDENTIFIER_GROUPS = ["identifiersSparse", "identifiersDense"];

describe("margin基準の判定への入れ替え(ADR 0333 2026-09-30 追記)——実測(K=60)の固定巡で縛る", () => {
  it("fixture の前提: この巡は candidate0PerRound(旧判定)が red・candidate1PerRound(margin判定)が green である(この JSON 自身が持つ、独立に計算済みの判定)", () => {
    const c0 = measurement.candidate0PerRound[FIXTURE_ROUND_INDEX];
    const c1 = measurement.candidate1PerRound[FIXTURE_ROUND_INDEX];
    expect(c0.red).toBe(true);
    expect(c1.red).toBe(false);
  });

  for (const groupName of IDENTIFIER_GROUPS) {
    it(`${groupName}: 旧判定(decideShadowVerdict)は red、margin判定(decideMarginShadowVerdict)は green——固定した実測巡で`, () => {
      const measuredGroup = measuredGroups.find((g) => g.group === groupName);
      const baselineGroup = baselineGroups.find((g) => g.group === groupName);
      expect(measuredGroup).toBeDefined();
      expect(baselineGroup).toBeDefined();

      const oldVerdict = decideShadowVerdict(measuredGroup, baselineGroup);
      expect(oldVerdict.red).toBe(true);

      const marginVerdict = decideMarginShadowVerdict(measuredGroup, baselineGroup);
      expect(marginVerdict.comparable).toBe(true);
      expect(marginVerdict.red).toBe(false);
    });
  }

  it("buildSummaryMarkdown: margin基準の節が「判定」の見出しで、旧判定の節より前にある", () => {
    const markdown = buildSummaryMarkdown({
      title: "テスト(ADR 0333 fixture round)",
      measured: {
        schemaVersion: 1,
        status: "measured",
        measuredAt: "2026-09-30T00:00:00.000Z",
        commit: "test-fixture",
        groups: measuredGroups,
      },
      baseline: { groups: baselineGroups },
    });

    const marginHeadingIndex = markdown.indexOf("## 判定: margin基準");
    const legacyHeadingIndex = markdown.indexOf("## 旧判定");
    expect(marginHeadingIndex).toBeGreaterThan(-1);
    expect(legacyHeadingIndex).toBeGreaterThan(-1);
    expect(marginHeadingIndex).toBeLessThan(legacyHeadingIndex);

    // 旧判定の節に「⛔ 判定には使っていない」の見出しが残るので、markdown 全体ではなく margin基準の節だけを見る。
    const marginSection = markdown.slice(marginHeadingIndex, legacyHeadingIndex);
    expect(marginSection).not.toContain("参考");
    expect(marginSection).not.toContain("判定には使っていない");

    expect(marginSection).toContain("✅");
    expect(marginSection).not.toContain("🔴");
    const legacySection = markdown.slice(legacyHeadingIndex);
    expect(legacySection).toContain("🔴");
  });
});

// 逆向き(旧green・margin red)の歯は無い。local-margin-candidate-measurement.json は probe ごとの margin を持たず、判定関数を呼べない。
