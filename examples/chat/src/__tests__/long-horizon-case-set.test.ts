import { describe, expect, it } from "vitest";
import {
  FILLER_COMBINATION_COUNT,
  LONG_HORIZON_CHECKPOINT_DAYS,
  LONG_HORIZON_CORRECTION_DAY,
  LONG_HORIZON_DAYS,
  LONG_HORIZON_FACTS,
  LONG_HORIZON_FILLERS_PER_DAY,
  atDay,
  buildLongHorizonMemorySeeds,
  fillerContent,
  habitualMentionTimes,
} from "../long-horizon-case-set.js";

describe("long-horizon のケース集合", () => {
  const seeds = buildLongHorizonMemorySeeds();

  it("事実ごとに gold と distractor を、訂正には古い側も書き、雑談は日数 × 1日の件数だけ書く", () => {
    const corrections = LONG_HORIZON_FACTS.filter((f) => f.factClass === "correction").length;
    expect(seeds).toHaveLength(
      LONG_HORIZON_FACTS.length * 2 +
        corrections +
        LONG_HORIZON_DAYS * LONG_HORIZON_FILLERS_PER_DAY,
    );
    expect(seeds.filter((s) => s.role === "superseded")).toHaveLength(corrections);
  });

  it("3種類の事実をすべて含む", () => {
    const classes = new Set(LONG_HORIZON_FACTS.map((f) => f.factClass));
    expect(classes).toEqual(new Set(["habitual", "dormant", "correction"]));
  });

  it("記憶は記録時刻の昇順に並び、模擬期間の外に出ない", () => {
    for (let i = 1; i < seeds.length; i += 1) {
      expect(seeds[i]!.recordedAt.getTime()).toBeGreaterThanOrEqual(
        seeds[i - 1]!.recordedAt.getTime(),
      );
    }
    expect(seeds[seeds.length - 1]!.recordedAt.getTime()).toBeLessThan(
      atDay(LONG_HORIZON_DAYS).getTime(),
    );
  });

  it("訂正の新しい側は、古い側より後に記録される", () => {
    for (const fact of LONG_HORIZON_FACTS.filter((f) => f.factClass === "correction")) {
      const gold = seeds.find((s) => s.localId === `${fact.id}:gold`)!;
      const old = seeds.find((s) => s.localId === `${fact.id}:superseded`)!;
      expect(gold.recordedAt).toEqual(atDay(LONG_HORIZON_CORRECTION_DAY, 9));
      expect(old.recordedAt.getTime()).toBeLessThan(gold.recordedAt.getTime());
    }
  });

  it("本文はすべて異なる（同じ本文は同じテナントで冪等キーが衝突しうるうえ、どれが gold か区別できない）", () => {
    expect(new Set(seeds.map((s) => s.content)).size).toBe(seeds.length);
    expect(LONG_HORIZON_DAYS * LONG_HORIZON_FILLERS_PER_DAY).toBeLessThanOrEqual(
      FILLER_COMBINATION_COUNT,
    );
  });

  it("雑談は同じ番号から同じ文を作る", () => {
    expect(fillerContent(123)).toBe(fillerContent(123));
    expect(fillerContent(0)).not.toBe(fillerContent(1));
  });

  it("模擬期間の終わりは実時刻より前にある（埋め込みの処理で時計を実時刻へ進めたとき逆行させないため）", () => {
    expect(atDay(LONG_HORIZON_DAYS).getTime()).toBeLessThan(Date.now());
  });

  it("測る時点はすべて模擬期間の中にあり、話題に出る時刻は測る時刻と重ならない", () => {
    for (const day of LONG_HORIZON_CHECKPOINT_DAYS) {
      expect(day).toBeGreaterThan(0);
      expect(day).toBeLessThanOrEqual(LONG_HORIZON_DAYS);
    }
    const mentions = habitualMentionTimes().map((d) => d.getTime());
    for (const day of LONG_HORIZON_CHECKPOINT_DAYS) {
      expect(mentions).not.toContain(atDay(day, 12).getTime());
    }
  });
});
