import { describe, expect, it } from "vitest";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * `strategies/scoring.ts` に変異をまとめて当てたとき、どの歯も赤くならなかった形を縛る（Issue #1948）。
 * どれも TSDoc に書いてある約束で、既存の歯は呼んではいるが、違いが出る入力を渡していなかった。
 */

const HOUR = 1000 * 60 * 60;
const NOW = new Date("2026-01-11T00:00:00.000Z");

function baseInput() {
  return {
    now: NOW,
    tags: [] as string[],
    queryTags: [] as string[],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
  };
}

describe("defaultScoringStrategy: decayClock を省略したら、活動時計の入力が揃っていても壁時計だけで読む", () => {
  // 壁時計は10半減期ぶん沈み、活動時計は経過0で沈んでいない。両者が違う値になる入力でないと、
  // 省略時の既定を 'either'（max）や 'activity' に取り違えても decay が変わらない。
  const input = {
    ...baseInput(),
    lastReinforcedAt: new Date(NOW.getTime() - 240 * HOUR),
    nowSeq: 50,
    decayBaseSeq: 50,
    halfLifeRecalls: 10,
  };

  it("decay は壁時計の係数（2^-10）で、活動時計の係数（1）ではない", () => {
    const score = defaultScoringStrategy(input);
    expect(score.decay).toBeCloseTo(Math.pow(0.5, 10), 12);
  });

  it("省略時は decayClock: 'wall' を明示したときと同じ値になる", () => {
    expect(defaultScoringStrategy(input).decay).toBe(
      defaultScoringStrategy({ ...input, decayClock: "wall" }).decay,
    );
  });
});

describe("defaultScoringStrategy: decay は 1 で頭打ちにしない（freshness だけが頭打ち、ADR 0036）", () => {
  it("lastReinforcedAt が now より1半減期ぶん未来なら、decay は 2 になる", () => {
    const score = defaultScoringStrategy({
      ...baseInput(),
      lastReinforcedAt: new Date(NOW.getTime() + 24 * HOUR),
    });
    expect(score.decay).toBeCloseTo(2, 10);
    expect(score.total).toBeCloseTo(2, 10);
  });
});

describe("defaultScoringStrategy: lexicalMatch が無ければ、負の similarity をそのまま affinity にする", () => {
  it("similarity が負なら total も負になる（0 で切らない）", () => {
    const score = defaultScoringStrategy({ ...baseInput(), similarity: -0.2 });
    expect(score.total).toBeCloseTo(-0.2, 10);
  });
});

describe("defaultScoringStrategy: similarity は ANN 経由の候補にだけ存在する（ScoreBreakdown.similarity）", () => {
  // `toBeUndefined()` では `{ similarity: undefined }` も通るので、鍵の有無を Object.keys で見る
  // （lexicalMatch は recall-channels.test.ts の ②-c が同じ形で縛っている）。
  it("similarity を渡さなければ、score に similarity という鍵が無い", () => {
    const score = defaultScoringStrategy(baseInput());
    expect(Object.keys(score)).not.toContain("similarity");
  });

  it("陽性対照: similarity を渡せば鍵が在る", () => {
    const score = defaultScoringStrategy({ ...baseInput(), similarity: 0.5 });
    expect(Object.keys(score)).toContain("similarity");
  });
});
