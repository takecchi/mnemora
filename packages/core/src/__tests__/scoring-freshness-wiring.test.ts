import { describe, expect, it } from "vitest";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * `freshness` が「計算されている」ことと「順位（`total`）へ配線されている」ことは別物である。
 *
 * `packages/core/src/__tests__/scoring.test.ts` は前者（`freshness` の計算式そのもの
 * ——`occurredAt` を優先する・古いほど低くなる、等）を既に守っている。
 * このファイルは後者だけを守る——**`freshness` が `total` の積に実際に合成されているか。**
 * `total = affinity * decay * tagMatch * freshness * strength` という式の中から
 * `freshness` を丸ごと落とす変異（≒ 配線を切る）を入れても、`scoring.test.ts` の
 * どの `it` も検出しない（`defaultScoringStrategy` を直接呼んで `score.freshness` を見る
 * 歯はあっても、`score.total` の大小関係から `freshness` の寄与を確かめる歯は無いため）。
 * このファイルはその穴を埋める。
 *
 * ⛔ **このファイルが示さないもの**（`describe`/`it` の名前にも明記する）:
 * - **`freshness` の計算式そのものの正しさ**（`occurredAt` を優先するか・式の形が
 *   正しいか）——それは `scoring.test.ts` の管轄であり、ここでは検査しない。
 * - **`decay` の配線**（`lastReinforcedAt` の違いが `total` に効くか）——
 *   本ファイルの範囲外。理由は本 PR の ADR に書いた（オーナーが範囲を切った。
 *   技術的な障害があるからではない——このファイルと同じ形で `lastReinforcedAt` だけを
 *   変えれば同様に守れる）。
 * - **`recall()` から先の経路**——このファイルは `defaultScoringStrategy` という
 *   スコア戦略1つを直接呼んでいるだけで、`recall()` が実際に `total` で候補を
 *   並べ替えていることは検査していない。
 */

const HOUR = 1000 * 60 * 60;
const DAY = 24 * HOUR;

function baseInput(now: Date) {
  return {
    now,
    tags: [] as string[],
    queryTags: [] as string[],
    recordedAt: now,
    lastReinforcedAt: null as Date | null,
    strength: 1,
    halfLifeHours: 24,
    // similarity / lexicalMatch は渡さない ⟹ affinity は中立の 1 に退化する
    // （`scoring.ts` 冒頭の doc）。tagMatch も queryTags 空で中立の 1。
    // ⟹ occurredAt 以外の全項を意図的に中立化し、total の差を freshness だけに帰属させる。
  };
}

describe("defaultScoringStrategy — freshness の『配線』（occurredAt の差が total へ伝わるか）", () => {
  it(
    "本題: occurredAt だけが違う2候補で、新しいほうの total が厳密に大きい" +
      "（⟹ freshness が計算式の中だけに留まらず total の積に合成されている）",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");

      // 他の項（recordedAt/lastReinforcedAt/strength/tagMatch/similarity/now）は
      // すべて同一。occurredAt だけを変える。
      const recent = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: now,
      });
      const stale = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: new Date(now.getTime() - 400 * DAY),
      });

      // freshness が total から外れている（配線切れ）と、この不等号は成立しない
      // （400日前の候補と「たったいま」の候補が同順位になる。本 PR の ADR が
      // 陽性対照として実測した壊れ方そのもの）。
      expect(recent.total).toBeGreaterThan(stale.total);
    },
  );

  it(
    "⭐ 計算式と配線を分ける: 同じ2候補で score.freshness 自体も異なる" +
      "（この it が緑で上の it だけが赤いなら『配線が切れた』、両方赤いなら『計算式が壊れた』" +
      "——赤くなる it の違いで2つの壊れ方を読み分ける）",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");

      const recent = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: now,
      });
      const stale = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: new Date(now.getTime() - 400 * DAY),
      });

      expect(recent.freshness).not.toBe(stale.freshness);
      expect(recent.freshness).toBeGreaterThan(stale.freshness);
    },
  );

  it(
    "陰性対照: occurredAt が同一の2候補では total が等しい" +
      "（⟹ この歯は『何にでも差を主張する』壊れた検査ではない）",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const occurredAt = new Date(now.getTime() - 10 * DAY);

      const a = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt,
      });
      const b = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: new Date(occurredAt.getTime()), // 値は同じ・別インスタンス
      });

      expect(a.total).toBe(b.total);
      expect(a.freshness).toBe(b.freshness);
    },
  );
});
