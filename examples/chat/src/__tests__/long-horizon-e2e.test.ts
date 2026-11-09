import { describe, expect, it } from "vitest";
import { atDay } from "../long-horizon-case-set.js";
import {
  formatLongHorizonE2EReport,
  utteranceOf,
  type LongHorizonE2EReport,
} from "../long-horizon-e2e.js";

describe("long-horizon-e2e: 段階1の文を発話として流す", () => {
  it("記憶として書くための三人称（先頭の「この人の」）だけを落とし、ほかの文はそのまま発話にする", () => {
    const seed = { localId: "x", role: "gold" as const, factId: "f", recordedAt: atDay(0) };
    expect(utteranceOf({ ...seed, content: "この人の娘の名前は「さくら」だ。" })).toBe(
      "娘の名前は「さくら」だ。",
    );
    expect(utteranceOf({ ...seed, content: "同僚の娘さんは「ひなた」という名前らしい。" })).toBe(
      "同僚の娘さんは「ひなた」という名前らしい。",
    );
  });

  it("表は、返った件数と返らなかった理由の内訳を出し、抽出されなかった gold は nx として数える", () => {
    const report: LongHorizonE2EReport = {
      days: 8,
      fillersPerDay: 1,
      checkpointDays: [7],
      utterancesObserved: 3,
      memoriesByRole: {
        gold: { utterances: 2, memories: 1 },
        superseded: { utterances: 0, memories: 0 },
        distractor: { utterances: 0, memories: 0 },
        filler: { utterances: 1, memories: 2 },
      },
      memoriesAtCheckpoint: [{ day: 7, memories: 3 }],
      factExtractions: [],
      probes: [
        {
          arm: "A",
          checkpointDay: 7,
          factId: "h1",
          factClass: "habitual",
          role: "gold",
          outcome: "returned",
          extractedCount: 1,
          returnedRank: 1,
          diagnosticRank: 1,
          similarity: 0.9,
          total: 0.9,
        },
        {
          arm: "A",
          checkpointDay: 7,
          factId: "h2",
          factClass: "habitual",
          role: "gold",
          outcome: "not_extracted",
          extractedCount: 0,
          returnedRank: null,
          diagnosticRank: null,
          similarity: null,
          total: null,
        },
      ],
      observeMillis: 300,
    };

    const text = formatLongHorizonE2EReport(report);

    expect(text).toContain("| 常用 | A | 1/2 nx1 |");
    expect(text).toContain("| 常用 | C | — |");
  });
});
