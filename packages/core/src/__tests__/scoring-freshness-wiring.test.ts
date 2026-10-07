import { describe, expect, it } from "vitest";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * `freshness`/`decay` が「計算されている」ことと「`total` の積に配線されている」ことは別物で、このファイルは後者だけを守る
 * （計算式そのものは `scoring.test.ts`）。`freshness` と `decay` は起点が違う（`occurredAt ?? recordedAt` と `lastReinforcedAt ?? recordedAt`）ので、
 * 片方の配線が切れても他方の `describe` が緑のままになるよう、別の `describe` で守る。`recall()` から先の経路は見ない。
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

      const recent = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: now,
      });
      const stale = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: new Date(now.getTime() - 400 * DAY),
      });

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

describe("defaultScoringStrategy — decay の『配線』（lastReinforcedAt の差が total へ伝わるか）", () => {
  // occurredAt はすべての候補で同一（null＝recordedAt に退化）に固定し、freshness 側は
  // 一切動かさない。⟹ total の差を lastReinforcedAt（decay の起点）だけに帰属させる。

  it(
    "本題: lastReinforcedAt だけが違う2候補で、新しいほうの total が厳密に大きい" +
      "（⟹ decay が計算式の中だけに留まらず total の積に合成されている）",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");

      const recentlyReinforced = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: null,
        lastReinforcedAt: now,
      });
      const staleReinforced = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: null,
        lastReinforcedAt: new Date(now.getTime() - 400 * DAY),
      });

      expect(recentlyReinforced.total).toBeGreaterThan(staleReinforced.total);
    },
  );

  it(
    "⭐ 計算式と配線を分ける: 同じ2候補で score.decay 自体も異なる" +
      "（この it が緑で上の it だけが赤いなら『配線が切れた』、両方赤いなら『計算式が壊れた』" +
      "——赤くなる it の違いで2つの壊れ方を読み分ける）",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");

      const recentlyReinforced = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: null,
        lastReinforcedAt: now,
      });
      const staleReinforced = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: null,
        lastReinforcedAt: new Date(now.getTime() - 400 * DAY),
      });

      expect(recentlyReinforced.decay).not.toBe(staleReinforced.decay);
      expect(recentlyReinforced.decay).toBeGreaterThan(staleReinforced.decay);
    },
  );

  it(
    "陰性対照: lastReinforcedAt が同一の2候補では total が等しい" +
      "（⟹ この歯は『何にでも差を主張する』壊れた検査ではない）",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const lastReinforcedAt = new Date(now.getTime() - 10 * DAY);

      const a = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: null,
        lastReinforcedAt,
      });
      const b = defaultScoringStrategy({
        ...baseInput(now),
        occurredAt: null,
        lastReinforcedAt: new Date(lastReinforcedAt.getTime()), // 値は同じ・別インスタンス
      });

      expect(a.total).toBe(b.total);
      expect(a.decay).toBe(b.decay);
    },
  );
});
