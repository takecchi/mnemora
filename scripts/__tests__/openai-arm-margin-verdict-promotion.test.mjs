import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  decideMarginShadowVerdict,
  decideShadowVerdict,
} from "../openai-arm-summary-lib.mjs";

/**
 * ADR 0333 §2・§4.1・§4.3「A」の 2026-09-30 追記——Issue #109 残件A。
 *
 * `scripts/openai-arm-summary-lib.mjs` の Job Summary で、**判定を margin基準
 * （ADR 0333）へ入れ替え、旧判定（ADR 0316）を移行の追跡用としてその下へ残した。**
 * この歯は、その入れ替えが実際に起きていることを、**コミット済みの実測データ**で縛る。
 *
 * ## fixture の選び方（JSON から読む・値をテストに写さない）
 *
 * `examples/chat/openai-margin-candidate-measurement.json`（ADR 0333 §2.3 の実測
 * K=60、実 API・`node -e` で突き合わせ済み）の `perRound[4]`（内部の `round` 番号は
 * この JSON 自身が持つ——ここでは写さない）を、**このテストが実行するたびに JSON から
 * 読み直す**（値をここへハードコードしない）。同じ round について、この JSON 自身が
 * 既に計算済みの `candidate0PerRound[4]`/`candidate1PerRound[4]`（ADR 0333 の実測
 * スクリプトが `decideEmbeddingDriftVerdict`/`decideMarginDropVerdict` を通して
 * 出した判定）を「もう一つの独立な確認」として使い、この歯が読んだ生データからの
 * 再計算と食い違わないことも縛る。
 *
 * group の表示用スキーマ（`label`/`llmMode`/`embeddingMode`/`embeddingSpace`/
 * `haystackKind`）は、`openai-margin-candidate-measurement.json` には無い
 * （この測定専用スクリプトが吐く形は群集約値と probe ごとの margin だけを持つ、
 * 軽量な形）。**production の Job Summary が実際に読む基準値ファイル
 * （`identifier-probe-baseline.openai.json`/`numeral-token-probe-baseline.openai.json`、
 * どちらもコミット済み）から同じ値を読み、merge する**——表示用の付随情報であり、
 * red/green の判定ロジックには影響しない。
 */

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

/**
 * `openai-margin-candidate-measurement.json` の群1件(`{group, probes: [{probeId,
 * margin, ...}], mrrOverall, hit1Count, hit10Count, probeCount}`)を、
 * `openai-arm-summary-lib.mjs` の関数が読める形(`probeMargins` フィールド名、
 * production と同じ表示用スキーマ付き)へ変換する。判定に使う数値
 * (`mrrOverall`/`hit1Count`/`hit10Count`/`probeCount`/margin)はすべて元の JSON から
 * そのまま持ってくる——このテストで作り直さない。
 */
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

// ADR 0333 §2.3 の実測(K=60)で「旧red・margin green」になった巡は round index にして
// 4, 22, 24, 28, 36, 51, 56 の7つ(マネージャーからの依頼で確認済み)。ここでは先頭の
// index 4 を1つ固定して使う——index の選び方自体は Issue #109 の依頼にある。
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

    // 「参考」「判定には使っていない」の文言は、margin基準の節からは外れている。
    // (旧判定の節には「⛔ 判定には使っていない」という見出しが残るので、
    //  markdown 全体からではなく margin基準の節の範囲だけを見る。)
    const marginSection = markdown.slice(marginHeadingIndex, legacyHeadingIndex);
    expect(marginSection).not.toContain("参考");
    expect(marginSection).not.toContain("判定には使っていない");

    // この巡では、判定(margin基準)は green、旧判定(ADR 0316)は red。
    expect(marginSection).toContain("✅");
    expect(marginSection).not.toContain("🔴");
    const legacySection = markdown.slice(legacyHeadingIndex);
    expect(legacySection).toContain("🔴");
  });
});

/**
 * 逆向き(旧green・margin red、「中間的な劣化を margin 基準が見逃す」の裏)の歯は、
 * ここには無い。理由(マネージャーへの報告と同じ内容をここにも残す):
 *
 * `examples/chat/local-margin-candidate-measurement.json`(ADR 0333 §2.4 の local 反実仮想、
 * `japanese` 群 σ=0.08 付近)を調べたが、この JSON は **σ ごとの red 件数の集計値
 * (`candidate0RedCount`/`candidate1RedCount`、15 seed 中の件数)だけ**を持ち、
 * **probe ごとの margin(baseline/measured 双方)を保存していない**——`decideShadowVerdict`/
 * `decideMarginShadowVerdict` を実際に呼ぶには、`probeMargins`(`{probeId, margin}[]`)が
 * 要るが、この JSON にはその生データが無い(`baseline` フィールドも `mrrOverall`/
 * `hit1Count`/`hit10Count`/`probeCount` の集約値だけで `probeMargins` を持たない)。
 * 生成スクリプト(`examples/chat/src/scripts/local-margin-candidate-measurement.ts`)を
 * 再実行すれば seed ごとの生データを再現できる可能性はあるが、`DATABASE_URL` の
 * ある本物の Postgres + `@mnemora/local-embedding`(実推論)を要求し、この実装 PR の
 * 範囲(既存の測定 JSON を読むだけ)を超える——今回は実行していない。
 */
