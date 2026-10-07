import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
  DEFAULT_FOOTPRINT_TOLERANCE,
  FOOTPRINT_STRUCTURAL_CONSTANTS,
  calibrateRecallFootprint,
  compareWithFullLog,
  estimateRecallFootprint,
  footprintSampleFromRecall,
  type RecallFootprintProfile,
  type RecallFootprintSample,
  type RecallFootprintShape,
} from "../recall-footprint.js";
import { DEFAULT_RECALL_LIMIT } from "../recall.js";
import type { DigestEntry, RecallResult, RecalledMemory } from "../recall.js";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

describe("BUILTIN_RECALL_FOOTPRINT_PROFILE — 構造定数のずれを検知する歯", () => {
  it("origin.measuredUnder は FOOTPRINT_STRUCTURAL_CONSTANTS（現在値）と一致する", () => {
    const origin = BUILTIN_RECALL_FOOTPRINT_PROFILE.origin;
    if (origin.kind !== "builtin_default") {
      throw new Error(
        "unreachable: 同梱の既定プロファイルの origin.kind は builtin_default のはず",
      );
    }
    expect(
      origin.measuredUnder,
      "既定プロファイルの係数（charsPerDigest / fixedIndexChars）は、origin.measuredUnder に" +
        "記録した構造定数の下で測った値である。この歯が赤くなったということは、recall.ts /" +
        "digest-band.ts 側の構造定数（DEFAULT_RECALL_LIMIT・DEFAULT_DIGEST_BAND_LIMIT・" +
        "DIGEST_BAND_MAX_CHARS・DIGEST_BAND_MAX_ENTRY_CHARS・digestBandEntryFixedOverheadChars・" +
        "digestBandEntrySeparatorChars のいずれか）を動かしたのに、既定プロファイルの係数を" +
        "測り直していない、ということである。定数を変えたなら BUILTIN_RECALL_FOOTPRINT_PROFILE を" +
        "（examples/chat/compare-baseline.json を実測し直したうえで）測り直すこと。",
    ).toEqual(FOOTPRINT_STRUCTURAL_CONSTANTS);
  });
});

/** BUILTIN の実測値ではなく、境界の算術だけを検査するプロファイル。charsPerDigest=100（切り詰めは起きない）で、50件が確実に DIGEST_BAND_MAX_CHARS に当たる（50 × (63+1+100) = 8200 ≫ 4000）。 */
const shapeTestProfile: RecallFootprintProfile = {
  origin: {
    kind: "calibrated",
    sampleCount: 5,
    observedMemoryCount: { min: 1, max: 200 },
    borrowedFromDefault: [],
  },
  charsPerDigest: 100,
  fixedIndexChars: 100,
};

// 既定の許容誤差 5% は `compareWithFullLog` が 'too_close_to_call' を返す幅なので、動くと判定が静かに変わる。
// 値の根拠（較正後の最大残差 2.023% が内側）が崩れたら、決め直す合図にする。
describe("DEFAULT_FOOTPRINT_TOLERANCE — 既定の許容誤差は 5%", () => {
  it("値は 0.05", () => {
    expect(DEFAULT_FOOTPRINT_TOLERANCE).toBe(0.05);
  });
});

describe("estimateRecallFootprint — 境界", () => {
  it("memoryCountInScope が 0 なら、返る件数も帯の件数も 0（chars は固定分だけ）", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 0 }, shapeTestProfile);
    expect(est.returnedMemories).toBe(0);
    expect(est.bandEntries).toBe(0);
    expect(est.memoriesCappedByLimit).toBe(false);
    expect(est.bandSaturated).toBe(false);
    expect(est.chars).toBe(shapeTestProfile.fixedIndexChars);
  });

  it("memoryCountInScope が limit 未満なら、全件返り、目次帯は空", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 5, limit: 10 }, shapeTestProfile);
    expect(est.returnedMemories).toBe(5);
    expect(est.bandEntries).toBe(0);
    expect(est.memoriesCappedByLimit).toBe(false);
    expect(est.bandSaturated).toBe(false);
  });

  it("memoryCountInScope が limit を超えたら returnedMemories は limit で頭打ち、残りが目次帯へ回る（まだ飽和しない大きさ）", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 30, limit: 10 }, shapeTestProfile);
    expect(est.returnedMemories).toBe(10);
    expect(est.memoriesCappedByLimit).toBe(true);
    expect(est.bandEntries).toBe(20); // min(DEFAULT_DIGEST_BAND_LIMIT=50, 30-10)
    expect(est.bandSaturated).toBe(false);
  });

  it("目次帯が DIGEST_BAND_MAX_CHARS に当たると bandSaturated が true になる", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 100, limit: 10 }, shapeTestProfile);
    expect(est.bandEntries).toBe(50); // DEFAULT_DIGEST_BAND_LIMIT に頭打ち
    expect(est.bandSaturated).toBe(true);
  });
});

describe("estimateRecallFootprint — 帯が飽和した後、chars の増分は totalInScope/eligible の桁上がり（構造項(b)/(c)）だけで説明できる", () => {
  /** `recall-footprint.ts` の `extraDigitsBeyondOne` と同じ計算を、実装から独立に複製する。 */
  function extraDigitsBeyondOne(n: number): number {
    return Math.max(0, String(Math.max(0, Math.trunc(n))).length - 1);
  }

  it("bandSaturated な状況で memoryCountInScope を増やしても、band/digest tier 自体は変わらない", () => {
    const a = estimateRecallFootprint({ memoryCountInScope: 100, limit: 10 }, shapeTestProfile);
    const b = estimateRecallFootprint({ memoryCountInScope: 100_000, limit: 10 }, shapeTestProfile);
    expect(a.bandSaturated).toBe(true);
    expect(b.bandSaturated).toBe(true);
    expect(b.returnedMemories).toBe(a.returnedMemories);
    expect(b.bandEntries).toBe(a.bandEntries);
    expect(b.byTier.digest).toBe(a.byTier.digest);
  });

  it("chars の増分は、totalInScope・shown(bandEntries)・eligible(帯の資格件数) の桁上がりを式から計算した値と厳密に一致する", () => {
    const a = estimateRecallFootprint({ memoryCountInScope: 100, limit: 10 }, shapeTestProfile);
    const b = estimateRecallFootprint({ memoryCountInScope: 100_000, limit: 10 }, shapeTestProfile);

    const bandEligibleA = 100 - a.returnedMemories; // = 90
    const bandEligibleB = 100_000 - b.returnedMemories; // = 99,990

    // 構造項(b): totalInScope の桁上がりは JSON 上 totalInScope 欄と(単一group想定の)
    // groups[0].count 欄の両方に効くので 2倍。
    const totalInScopeCarryDiff = 2 * (extraDigitsBeyondOne(100_000) - extraDigitsBeyondOne(100));
    // 構造項(c): digestBandCoverage.shown(=bandEntries)・eligible(=帯の資格件数) の桁上がり。
    // shown は a/b とも 50(2桁)で同じなので寄与0——それでも式には残し、
    // 「たまたま0」であることを明示する。
    const shownCarryDiff =
      extraDigitsBeyondOne(b.bandEntries) - extraDigitsBeyondOne(a.bandEntries);
    const eligibleCarryDiff =
      extraDigitsBeyondOne(bandEligibleB) - extraDigitsBeyondOne(bandEligibleA);

    const expectedCharsDiff = totalInScopeCarryDiff + shownCarryDiff + eligibleCarryDiff;

    expect(expectedCharsDiff).toBe(9);
    expect(b.byTier.index - a.byTier.index).toBe(expectedCharsDiff);
    expect(b.chars - a.chars).toBe(expectedCharsDiff);
  });
});

/** `toEqual` で丸ごと検査する: 特定の欄だけを見比べると、見落とした欄が静かに変わっても気づけない。 */
describe("estimateRecallFootprint — associationCount を渡さない呼び出しは、ADR 0166 より前と1ビットも変わらない（後方互換）", () => {
  const shapesWithoutAssociation: RecallFootprintShape[] = [
    { memoryCountInScope: 0 },
    { memoryCountInScope: 5, limit: 10 },
    { memoryCountInScope: 30, limit: 10 },
    { memoryCountInScope: 100, limit: 10 },
    { memoryCountInScope: 100_000, limit: 10 },
  ];

  it.each(shapesWithoutAssociation)(
    "%o — 省略時と associationCount: 0 を明示したときの見積もりが完全に一致する",
    (shape) => {
      const omitted = estimateRecallFootprint(shape, shapeTestProfile);
      const explicitZero = estimateRecallFootprint(
        { ...shape, associationCount: 0 },
        shapeTestProfile,
      );
      expect(omitted).toEqual(explicitZero);
      expect(omitted.associationCount).toBe(0);
    },
  );

  /** 複製した式には実装と同じ構造項を足してある（独立な再実装との一致で検算する）。association を考慮しない `returnedMemories`/`bandEntries` の決め方は `for` ループが個別に検査する。 */
  it("省略時の見積もりは、ADR 0166 以前の式（association 非対応）に Issue #340 の構造項を足したものと一致する", () => {
    function preAdr0166WithStructuralTerms(shape: { memoryCountInScope: number; limit?: number }) {
      const inScope = Math.max(0, shape.memoryCountInScope);
      const limit = shape.limit ?? DEFAULT_RECALL_LIMIT;
      const bandLimit = 50; // DEFAULT_DIGEST_BAND_LIMIT
      const returnedMemories = Math.min(limit, inScope); // ADR 0166 以前: association を足さない
      const bandEligible = Math.max(0, inScope - returnedMemories);
      const bandEntries = Math.min(bandLimit, bandEligible);
      const perEntry = 63 + 1 + Math.min(shapeTestProfile.charsPerDigest, 120);
      const uncappedBandChars = bandEntries * perEntry;
      const bandSaturated = uncappedBandChars >= 4000; // DIGEST_BAND_MAX_CHARS

      function extraDigitsBeyondOne(n: number): number {
        return Math.max(0, String(Math.max(0, Math.trunc(n))).length - 1);
      }
      const commaOvercount = !bandSaturated && bandEntries >= 1 ? 1 : 0; // 構造項(a)
      const bandChars = Math.min(uncappedBandChars, 4000) - commaOvercount;
      const totalInScopeDigitCarry = 2 * extraDigitsBeyondOne(inScope); // 構造項(b)
      const bandCoverageDigitCarry =
        extraDigitsBeyondOne(bandEntries) + extraDigitsBeyondOne(bandEligible); // 構造項(c)
      const limitedByChars = !bandSaturated && bandEligible > bandEntries ? 26 : 0; // 構造項(d)

      const digestChars = returnedMemories * shapeTestProfile.charsPerDigest;
      const indexChars =
        shapeTestProfile.fixedIndexChars +
        bandChars +
        totalInScopeDigitCarry +
        bandCoverageDigitCarry +
        limitedByChars;
      return { returnedMemories, bandEntries, chars: digestChars + indexChars };
    }

    for (const shape of shapesWithoutAssociation) {
      const expected = preAdr0166WithStructuralTerms(shape);
      const actual = estimateRecallFootprint(shape, shapeTestProfile);
      expect(actual.returnedMemories).toBe(expected.returnedMemories);
      expect(actual.bandEntries).toBe(expected.bandEntries);
      expect(actual.chars).toBe(expected.chars);
    }
  });
});

describe("estimateRecallFootprint — associationCount（連想枠が本体へ昇格させた件数）", () => {
  it("帯が件数で飽和していない領域では、昇格1件ごとに『帯の1件』が『本体の1件』に置き換わる", () => {
    const without = estimateRecallFootprint(
      { memoryCountInScope: 30, limit: 10 },
      shapeTestProfile,
    );
    const withAssociation = estimateRecallFootprint(
      { memoryCountInScope: 30, limit: 10, associationCount: 3 },
      shapeTestProfile,
    );

    expect(without.bandEntries).toBe(20);
    expect(withAssociation.returnedMemories).toBe(13); // 10 + 3
    expect(withAssociation.associationCount).toBe(3);
    expect(withAssociation.bandEntries).toBe(17); // 20 - 3（帯から本体へ移った）

    expect(withAssociation.chars).toBe(without.chars - 3 * 64);
  });

  it("帯が件数で既に飽和している領域では、昇格は帯の費用を減らさず、本体側の費用だけ純増する", () => {
    const without = estimateRecallFootprint(
      { memoryCountInScope: 100, limit: 10 },
      shapeTestProfile,
    );
    const withAssociation = estimateRecallFootprint(
      { memoryCountInScope: 100, limit: 10, associationCount: 5 },
      shapeTestProfile,
    );

    expect(without.bandEntries).toBe(50);
    expect(withAssociation.returnedMemories).toBe(15); // 10 + 5
    expect(withAssociation.bandEntries).toBe(50); // 帯資格 85 はまだ50を超えるので変わらない
    // 帯の費用は変わらない(どちらも DIGEST_BAND_MAX_CHARS で頭打ち) ので、
    // 本体側の増分(5 × charsPerDigest=100 = 500)がそのまま純増になる。
    expect(withAssociation.chars).toBe(without.chars + 5 * shapeTestProfile.charsPerDigest);
  });

  it("associationCount が limit の外に居る候補の総数を超えていたら、構造上の上限で切り詰める", () => {
    const est = estimateRecallFootprint(
      { memoryCountInScope: 12, limit: 10, associationCount: 999 },
      shapeTestProfile,
    );
    expect(est.associationCount).toBe(2);
    expect(est.returnedMemories).toBe(12); // 全件が本体へ入り、帯は空になる
    expect(est.bandEntries).toBe(0);
  });

  it("負の associationCount は 0 として扱う（構造上ありえない値を静かに受け入れない）", () => {
    const est = estimateRecallFootprint(
      { memoryCountInScope: 30, limit: 10, associationCount: -5 },
      shapeTestProfile,
    );
    expect(est.associationCount).toBe(0);
    expect(est.returnedMemories).toBe(10);
  });
});

describe("calibrateRecallFootprint — 3階建て", () => {
  it("(a) memoryCount が2種類以上ある帯なし標本 → borrowedFromDefault は空（両係数とも標本から決まる）", () => {
    const samples: RecallFootprintSample[] = [
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 700, memoryCount: 15, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    expect(profile.origin.sampleCount).toBe(3);
    expect(profile.origin.observedMemoryCount).toEqual({ min: 5, max: 15 });
    expect(profile.charsPerDigest).toBeCloseTo(40, 9);
    expect(profile.fixedIndexChars).toBeCloseTo(100, 9);
  });

  it("(b) memoryCount が1種類だけ → fixedIndexChars だけを既定値から借りる（charsPerDigest は標本から決まる）", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const samples: RecallFootprintSample[] = [
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 520, memoryCount: 10, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples, fallback);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["fixedIndexChars"]);
    expect(profile.fixedIndexChars).toBe(fallback.fixedIndexChars);
    const meanY = (500 + 520) / 2;
    expect(profile.charsPerDigest).toBeCloseTo((meanY - fallback.fixedIndexChars) / 10, 9);
  });

  it("(c) 使える標本がゼロ（全部 bandEntryCount > 0）→ 両方の係数を既定値から借りる", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const samples: RecallFootprintSample[] = [
      { totalChars: 900, memoryCount: 10, bandEntryCount: 3 },
      { totalChars: 950, memoryCount: 12, bandEntryCount: 2 },
    ];
    const profile = calibrateRecallFootprint(samples, fallback);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["charsPerDigest", "fixedIndexChars"]);
    expect(profile.origin.sampleCount).toBe(0);
    expect(profile.origin.observedMemoryCount).toEqual({ min: 0, max: 0 });
    expect(profile.charsPerDigest).toBe(fallback.charsPerDigest);
    expect(profile.fixedIndexChars).toBe(fallback.fixedIndexChars);
  });

  it("(b') memoryCount が1種類で、借りた切片が標本の総量より大きい（傾きが0以下）→ charsPerDigest も借りて名乗る", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const samples: RecallFootprintSample[] = [
      { totalChars: fallback.fixedIndexChars - 1, memoryCount: 10, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples, fallback);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["fixedIndexChars", "charsPerDigest"]);
    expect(profile.charsPerDigest).toBe(fallback.charsPerDigest);
  });

  it("(b') memoryCount が1種類で、傾きがちょうど0（借りた切片が標本の総量と等しい）でも、0を採らず charsPerDigest も借りて名乗る", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const profile = calibrateRecallFootprint(
      [{ totalChars: fallback.fixedIndexChars, memoryCount: 10, bandEntryCount: 0 }],
      fallback,
    );
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["fixedIndexChars", "charsPerDigest"]);
    expect(profile.charsPerDigest).toBe(fallback.charsPerDigest);
  });

  it("使えない標本（帯のある標本）が混ざっていても、係数・sampleCount・observedMemoryCount は使える標本だけで決まる", () => {
    const samples: RecallFootprintSample[] = [
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 9000, memoryCount: 40, bandEntryCount: 3 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 1, memoryCount: 2, bandEntryCount: 1 },
      { totalChars: 700, memoryCount: 15, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    expect(profile.origin.sampleCount).toBe(3);
    expect(profile.origin.observedMemoryCount).toEqual({ min: 5, max: 15 });
    expect(profile.charsPerDigest).toBeCloseTo(40, 9);
    expect(profile.fixedIndexChars).toBeCloseTo(100, 9);
  });

  // 最小二乗の枝（memoryCount が2種類以上）でも、1種類の枝と同じ規律を守る——
  // digest の平均長が0以下であることはありえないので、その傾きを係数として採らず、
  // 既定値から借りて borrowedFromDefault に名前で出す（借りていない顔で負の係数を返さない）。
  it.each([
    ["負", [2000, 500]],
    ["ちょうど0", [800, 800]],
  ])(
    "(d) memoryCount が2種類以上で、最小二乗の傾きが%sになる → charsPerDigest を既定値から借りて名乗り、見積もりの chars は負にならない",
    (_label, [y1, y2]) => {
      const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
      const samples: RecallFootprintSample[] = [
        { totalChars: y1!, memoryCount: 1, bandEntryCount: 0 },
        { totalChars: y2!, memoryCount: 3, bandEntryCount: 0 },
      ];
      const profile = calibrateRecallFootprint(samples, fallback);
      if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
      expect(profile.origin.borrowedFromDefault).toEqual(["charsPerDigest"]);
      expect(profile.charsPerDigest).toBe(fallback.charsPerDigest);
      const meanX = (1 + 3) / 2;
      const meanY = (y1! + y2!) / 2;
      expect(profile.fixedIndexChars).toBeCloseTo(meanY - fallback.charsPerDigest * meanX, 9);
      const estimate = estimateRecallFootprint({ memoryCountInScope: 5, limit: 10 }, profile);
      expect(estimate.chars).toBeGreaterThan(0);
    },
  );

  it("(d) の対照: 最小二乗の傾きが正なら、何も借りない（(a) と同じ）", () => {
    const profile = calibrateRecallFootprint([
      { totalChars: 500, memoryCount: 1, bandEntryCount: 0 },
      { totalChars: 501, memoryCount: 3, bandEntryCount: 0 },
    ]);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    expect(profile.charsPerDigest).toBeCloseTo(0.5, 9);
  });

  it("(d) 標本が3件以上でも、借りた傾きのもとでの切片は『標本の平均を通る』（分母は標本の件数）", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const samples: RecallFootprintSample[] = [
      { totalChars: 2000, memoryCount: 1, bandEntryCount: 0 },
      { totalChars: 1200, memoryCount: 2, bandEntryCount: 0 },
      { totalChars: 700, memoryCount: 6, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples, fallback);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["charsPerDigest"]);
    expect(profile.origin.sampleCount).toBe(3);
    const meanX = (1 + 2 + 6) / 3;
    const meanY = (2000 + 1200 + 700) / 3;
    expect(profile.fixedIndexChars).toBeCloseTo(meanY - fallback.charsPerDigest * meanX, 9);
  });

  describe("借り元は、引数の fallback である（同梱の既定ではない）", () => {
    const fallback: RecallFootprintProfile = {
      ...BUILTIN_RECALL_FOOTPRINT_PROFILE,
      charsPerDigest: 7,
      fixedIndexChars: 123,
    };

    it("最小二乗の傾きが0以下: 傾きを fallback から借り、切片はその傾きのもとで平均を通る", () => {
      const profile = calibrateRecallFootprint(
        [
          { totalChars: 2000, memoryCount: 1, bandEntryCount: 0 },
          { totalChars: 500, memoryCount: 3, bandEntryCount: 0 },
        ],
        fallback,
      );
      expect(profile.charsPerDigest).toBe(7);
      expect(profile.fixedIndexChars).toBeCloseTo((2500 - 7 * 4) / 2, 9);
    });

    it("memoryCount が1種類: 切片を fallback から借り、傾きはその切片のもとで決まる", () => {
      const profile = calibrateRecallFootprint(
        [
          { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
          { totalChars: 520, memoryCount: 10, bandEntryCount: 0 },
        ],
        fallback,
      );
      expect(profile.fixedIndexChars).toBe(123);
      expect(profile.charsPerDigest).toBeCloseTo((510 - 123) / 10, 9);
    });

    it("使える標本が無い: 両方の係数を fallback から借りる", () => {
      const profile = calibrateRecallFootprint(
        [{ totalChars: 900, memoryCount: 10, bandEntryCount: 3 }],
        fallback,
      );
      expect(profile.charsPerDigest).toBe(7);
      expect(profile.fixedIndexChars).toBe(123);
    });
  });

  it("(d) totalInScope 付きの標本: 構造項を差し引いたあとの傾きが0以下なら借りる（差し引く前は正でも）", () => {
    const fallback: RecallFootprintProfile = {
      ...BUILTIN_RECALL_FOOTPRINT_PROFILE,
      charsPerDigest: 0.1,
    };
    const samples: RecallFootprintSample[] = [
      { totalChars: 100, memoryCount: 5, bandEntryCount: 0, totalInScope: 5 },
      { totalChars: 102, memoryCount: 50, bandEntryCount: 0, totalInScope: 50 },
      { totalChars: 104, memoryCount: 500, bandEntryCount: 0, totalInScope: 500 },
    ];

    const profile = calibrateRecallFootprint(samples, fallback);

    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["charsPerDigest"]);
    expect(profile.charsPerDigest).toBe(0.1);
    expect(profile.fixedIndexChars).toBeCloseTo((300 - 0.1 * 555) / 3, 9);
  });

  it("⭐ (a) と (c) は origin.kind だけでは区別できないが、borrowedFromDefault で分岐できる", () => {
    const allDataDriven = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    const noneUsable = calibrateRecallFootprint([
      { totalChars: 900, memoryCount: 10, bandEntryCount: 3 },
    ]);

    expect(allDataDriven.origin.kind).toBe("calibrated");
    expect(noneUsable.origin.kind).toBe("calibrated");

    if (allDataDriven.origin.kind !== "calibrated" || noneUsable.origin.kind !== "calibrated") {
      throw new Error("unreachable");
    }
    expect(allDataDriven.origin.borrowedFromDefault).toEqual([]);
    expect(noneUsable.origin.borrowedFromDefault).toEqual(["charsPerDigest", "fixedIndexChars"]);
  });
});

describe("calibrateRecallFootprint — 構造項を差し引く（Issue #340 フォローアップ / ADR 0306）", () => {
  /** 既知の真の係数。丸め誤差と区別しやすいよう小数を選んだ。 */
  const TRUE_CHARS_PER_DIGEST = 12.3;
  const TRUE_FIXED_INDEX_CHARS = 200.7;

  /** テスト用の桁上がり計算——実装の `extraDigitsBeyondOne` とは独立に、素朴に数える。 */
  function extraDigitsBeyondOneForTest(n: number): number {
    return Math.max(0, String(n).length - 1);
  }

  /** `memoryCount = n`（全件を返す想定）にして帯を常に空にする: (a)(d) の構造項を0にし、効くのを(b)の桁上がりだけにするため。 */
  function syntheticSample(n: number, includeTotalInScope: boolean): RecallFootprintSample {
    const structuralCarry = 2 * extraDigitsBeyondOneForTest(n);
    const totalChars = TRUE_FIXED_INDEX_CHARS + TRUE_CHARS_PER_DIGEST * n + structuralCarry;
    return {
      totalChars,
      memoryCount: n,
      bandEntryCount: 0,
      ...(includeTotalInScope ? { totalInScope: n } : {}),
    };
  }

  const SCOPE_COUNTS = [4, 8, 55, 91, 137, 480];

  it("totalInScope を渡さなければ、2桁/3桁標本の桁上がりが係数に混ざり、真の係数から有意にずれる", () => {
    const samples = SCOPE_COUNTS.map((n) => syntheticSample(n, false));
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    // 閾値は 1e-4: 偏りは約 0.0075 / 1.03 で、浮動小数点の丸め（1e-10 台）より十分大きい。丸めとの取り違えを避ける。
    expect(Math.abs(profile.charsPerDigest - TRUE_CHARS_PER_DIGEST)).toBeGreaterThan(1e-4);
    expect(Math.abs(profile.fixedIndexChars - TRUE_FIXED_INDEX_CHARS)).toBeGreaterThan(1e-4);
  });

  it("totalInScope を渡せば、2桁/3桁標本が混ざっても真の係数へ戻る（構造項を差し引いた最小二乗）", () => {
    const samples = SCOPE_COUNTS.map((n) => syntheticSample(n, true));
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    expect(profile.charsPerDigest).toBeCloseTo(TRUE_CHARS_PER_DIGEST, 8);
    expect(profile.fixedIndexChars).toBeCloseTo(TRUE_FIXED_INDEX_CHARS, 6);
  });

  it("帯が空でも帯の資格件数（totalInScope − memoryCount）が在る標本は、その桁上がりと limitedBy の分も差し引いて真の係数へ戻る", () => {
    const scopeAndReturned: Array<[number, number]> = [
      [12, 3],
      [1500, 6],
      [120, 9],
    ];
    const samples = scopeAndReturned.map(([totalInScope, memoryCount]): RecallFootprintSample => {
      const eligible = totalInScope - memoryCount;
      const structuralCarry =
        2 * extraDigitsBeyondOneForTest(totalInScope) +
        extraDigitsBeyondOneForTest(eligible) +
        (eligible > 0 ? 26 : 0);
      return {
        totalChars: TRUE_FIXED_INDEX_CHARS + TRUE_CHARS_PER_DIGEST * memoryCount + structuralCarry,
        memoryCount,
        bandEntryCount: 0,
        totalInScope,
      };
    });

    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    expect(profile.charsPerDigest).toBeCloseTo(TRUE_CHARS_PER_DIGEST, 8);
    expect(profile.fixedIndexChars).toBeCloseTo(TRUE_FIXED_INDEX_CHARS, 6);
  });

  it("totalInScope を省略した標本は、構造項0として扱われる（既定値と1バイトも変わらない後方互換）", () => {
    const singleDigitCounts = [3, 5, 7];
    const withField = singleDigitCounts.map((n) => syntheticSample(n, true));
    const withoutField = singleDigitCounts.map((n) => syntheticSample(n, false));
    const profileWith = calibrateRecallFootprint(withField);
    const profileWithout = calibrateRecallFootprint(withoutField);
    expect(profileWith.charsPerDigest).toBe(profileWithout.charsPerDigest);
    expect(profileWith.fixedIndexChars).toBe(profileWithout.fixedIndexChars);
  });

  it("2桁/3桁を含む標本でも、totalInScope を省略した呼び出し1本の結果はこれまでの実装と同じ式で再現できる（回帰防止）", () => {
    const samples: RecallFootprintSample[] = [
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 700, memoryCount: 15, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.charsPerDigest).toBeCloseTo(40, 9);
    expect(profile.fixedIndexChars).toBeCloseTo(100, 9);
  });
});

describe("compareWithFullLog — reasons は空にならない", () => {
  it("較正済みプロファイルでも、較正した範囲の外を尋ねれば outside_calibrated_range が立つ（空にならない）", () => {
    const calibrated = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 100 },
      profile: calibrated,
    });
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.code === "outside_calibrated_range")).toBe(true);
  });

  it("既定プロファイル（BUILTIN_RECALL_FOOTPRINT_PROFILE）なら必ず profile_not_calibrated が立つ", () => {
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 8 },
    });
    expect(result.reasons.some((r) => r.code === "profile_not_calibrated")).toBe(true);
  });

  it("出所の札も量の札も1枚も立たない条件でも、dominant_term が立って reasons は空にならない", () => {
    const calibrated = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    // chars = 100(fixedIndexChars) + 8*40(charsPerDigest) = 420。420/1000=0.42 は
    // 既定許容誤差(0.05)の外 ⟹ within_tolerance も立たない。
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 8 },
      profile: calibrated,
    });
    expect(result.verdict).toBe("mnemora_smaller");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.map((r) => r.code)).toEqual(["dominant_term"]);
    const dominant = result.reasons.find((r) => r.code === "dominant_term");
    expect(dominant).toBeDefined();
    expect(dominant?.code === "dominant_term" ? dominant.term : undefined).toBe("memories");
  });

  it("どの入力でも reasons は空にならない（dominant_term が必ず立つ）", () => {
    const shapes = [0, 1, 5, 10, 11, 60, 1000, 100_000];
    for (const memoryCountInScope of shapes) {
      for (const fullLogChars of [0, 1, 200, 5000, 1_000_000]) {
        const result = compareWithFullLog({ fullLogChars, shape: { memoryCountInScope } });
        expect(result.reasons.length).toBeGreaterThan(0);
        expect(result.reasons.some((r) => r.code === "dominant_term")).toBe(true);
      }
    }
  });
});

describe("compareWithFullLog — fullLogChars: 0 で Infinity/NaN が verdict に漏れない", () => {
  it("fullLogChars が 0 でも verdict は3値のどれかであり、estimatedShare は NaN にならない", () => {
    const result = compareWithFullLog({ fullLogChars: 0, shape: { memoryCountInScope: 5 } });
    expect(["mnemora_smaller", "full_log_smaller", "too_close_to_call"]).toContain(result.verdict);
    expect(Number.isNaN(result.estimatedShare)).toBe(false);
    // 会話ログが0文字でも mnemora 側は固定分(fixedIndexChars)を必ず積むので、比は必ず1を超える。
    expect(result.verdict).toBe("full_log_smaller");
    expect(result.estimatedShare).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("compareWithFullLog — 許容誤差の内側は too_close_to_call", () => {
  it("見積もり比が1に十分近ければ too_close_to_call になり、within_tolerance の札が立つ", () => {
    const profile: RecallFootprintProfile = {
      origin: {
        kind: "calibrated",
        sampleCount: 5,
        observedMemoryCount: { min: 1, max: 20 },
        borrowedFromDefault: [],
      },
      charsPerDigest: 10,
      fixedIndexChars: 0,
    };
    function extraDigitsBeyondOne(n: number): number {
      return Math.max(0, String(Math.max(0, Math.trunc(n))).length - 1);
    }
    const expectedChars =
      10 * profile.charsPerDigest + profile.fixedIndexChars + 2 * extraDigitsBeyondOne(10);
    const est = estimateRecallFootprint({ memoryCountInScope: 10 }, profile);
    expect(est.chars).toBe(expectedChars); // = 100 + 0 + 2 = 102

    // fullLogChars は est.chars の1.03倍から導く: est.chars が今後動いても「許容誤差5%の内側」という意図が保たれる。
    const fullLogChars = Math.round(est.chars * 1.03);
    const estimatedShare = est.chars / fullLogChars;
    expect(Math.abs(estimatedShare - 1)).toBeLessThanOrEqual(0.05); // 既定許容誤差の内側

    const result = compareWithFullLog({
      fullLogChars,
      shape: { memoryCountInScope: 10 },
      profile,
    });
    expect(result.verdict).toBe("too_close_to_call");
    expect(result.reasons.some((r) => r.code === "within_tolerance")).toBe(true);
  });
});

function makeRecalledMemory(id: string): RecalledMemory {
  return {
    memoryId: id,
    digest: "d",
    retrievedVia: "ann",
    provenanceKind: "stated",
    score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 1 },
  };
}

function makeRecallResult(overrides: {
  chars: number;
  memoryCount: number;
  digestBand?: DigestEntry[];
  totalInScope?: number;
}): RecallResult {
  return {
    recallId: "r1",
    memories: Array.from({ length: overrides.memoryCount }, (_, i) => makeRecalledMemory(`m${i}`)),
    omitted: [],
    index: {
      groups: [],
      totalInScope: overrides.totalInScope ?? overrides.memoryCount,
      countKind: "exact",
      ...(overrides.digestBand !== undefined ? { digestBand: overrides.digestBand } : {}),
    },
    usage: {
      chars: overrides.chars,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

describe("footprintSampleFromRecall — RecallResult から3欄を取り出す", () => {
  it("usage.chars / memories.length / index.digestBand.length をそのまま写す", () => {
    const digestBand: DigestEntry[] = [
      { memoryId: "x1", digest: "a" },
      { memoryId: "x2", digest: "b" },
    ];
    const result = makeRecallResult({ chars: 999, memoryCount: 3, digestBand });
    const sample = footprintSampleFromRecall(result);
    expect(sample).toEqual({
      totalChars: 999,
      memoryCount: 3,
      bandEntryCount: 2,
      totalInScope: 3,
    });
  });

  it("index.digestBand が無ければ bandEntryCount は 0", () => {
    const result = makeRecallResult({ chars: 500, memoryCount: 5 });
    const sample = footprintSampleFromRecall(result);
    expect(sample.bandEntryCount).toBe(0);
  });

  it("totalInScope は index.totalInScope をそのまま写す（memoryCount とは独立）", () => {
    const result = makeRecallResult({ chars: 500, memoryCount: 5, totalInScope: 42 });
    const sample = footprintSampleFromRecall(result);
    expect(sample.totalInScope).toBe(42);
    expect(sample.memoryCount).toBe(5);
  });
});

// `estimateRecallFootprint` の見積もりと実際の `recall()` の `usage.chars` を、in-memory の runtime で突き合わせる。
// `charsPerDigest` は固定した digest 長、`fixedIndexChars` は基準シナリオの実測に合わせ、残る差を構造項だけにする。

describe("estimateRecallFootprint — 構造項をin-memory runtimeの実recall()に対して検算する（Issue #340）", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };
  const NOW = new Date("2026-06-01T00:00:00.000Z");
  const DIGEST_LEN = 10;
  const DIGEST = "a".repeat(DIGEST_LEN);

  function newTestMemory(overrides: Partial<NewMemory> = {}): NewMemory {
    const recordedAt = overrides.recordedAt ?? NOW;
    const strength = overrides.strength ?? 1;
    const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
    return {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: `hash-${Math.random()}`,
      digest: DIGEST,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
      embeddingStatus: "ready",
      ...overrides,
    };
  }

  function buildTestRuntime() {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          throw new Error("not used");
        },
      },
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    return { runtime, stores };
  }

  /**
   * `FakeMemoryStore` は id を `mem-<counter>` で振り桁数が伸び縮みするが、本物は常に36字の UUID で、
   * `DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS`（63）はそれを前提にする。id を36字へ揃えないと、検査したい構造差と無関係なノイズが入る。
   * `backing` は TS 上は private だが実行時にはただのプロパティなので、id の振り直しのためだけに直接触る。
   */
  function fixMemoryIdTo36Chars(
    stores: ReturnType<typeof createFakeRuntimeStores>,
    memory: { id: string },
    seq: number,
  ): string {
    const backing = (
      stores.memoryStore as unknown as { backing: { memories: Map<string, unknown> } }
    ).backing;
    const newId = `m${seq.toString().padStart(35, "0")}`; // 常に36字
    const existing = backing.memories.get(memory.id);
    backing.memories.delete(memory.id);
    backing.memories.set(newId, { ...(existing as object), id: newId });
    return newId;
  }

  interface Scenario {
    name: string;
    count: number;
    limit?: number;
    digestBandLimit?: number;
    multiGroup?: boolean;
  }

  async function recallFor(sc: Scenario): Promise<RecallResult> {
    const { runtime, stores } = buildTestRuntime();
    for (let i = 0; i < sc.count; i++) {
      const memory = await stores.memoryStore.createMemory(
        ctx,
        newTestMemory({
          subjectId: sc.multiGroup ? `subj-${i % 3}` : null,
          recordedAt: new Date(NOW.getTime() - i * 1000),
        }),
      );
      const fixedId = fixMemoryIdTo36Chars(stores, memory, i + 1);
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, fixedId, [1, 0]);
    }
    return runtime.recall(ctx, {
      vector: [1, 0],
      limit: sc.limit,
      digestBandLimit: sc.digestBandLimit,
      // association: null: 連想が本体へ何件昇格するかはこの歯の対象外。基準線（構造項の実測値）を動かさないために止める。
      association: null,
    });
  }

  const REFERENCE: Scenario = { name: "基準(帯なし・単一group・1桁)", count: 5, limit: 10 };

  it("基準シナリオでは fixedIndexChars をそのまま実測できる（帯なし・1桁なので構造項はすべて0）", async () => {
    const result = await recallFor(REFERENCE);
    expect(result.index.digestBand).toEqual([]);
    expect(result.index.groups).toHaveLength(1);
    expect(result.index.totalInScope).toBeLessThan(10);
    expect(result.index.digestBandCoverage?.shown).toBeLessThan(10);
    expect(result.index.digestBandCoverage?.eligible).toBeLessThan(10);
  });

  // 値は実装の構造定数から決まる実測値で、歯を通すために書き換えるものではない。

  /** 構造項だけを検査するプロファイル。`fixedIndexChars` は `calibrateRecallFootprint` を経由せず基準シナリオの実測を直書きし、歯の中で毎回検算する。 */
  let referenceFixedIndexChars: number | undefined;

  async function profileFor(): Promise<RecallFootprintProfile> {
    if (referenceFixedIndexChars === undefined) {
      const result = await recallFor(REFERENCE);
      referenceFixedIndexChars = result.usage.chars - result.memories.length * DIGEST_LEN;
    }
    return {
      origin: {
        kind: "calibrated",
        sampleCount: 1,
        observedMemoryCount: { min: 1, max: 1000 },
        borrowedFromDefault: [],
      },
      charsPerDigest: DIGEST_LEN,
      fixedIndexChars: referenceFixedIndexChars,
    };
  }

  const CLEAN_SCENARIOS: Scenario[] = [
    { name: "帯=0(1桁)", count: 5, limit: 10 },
    { name: "帯=1(1桁)", count: 6, limit: 5 },
    { name: "帯=2(1桁)", count: 7, limit: 5 },
    { name: "帯=多数、切り詰めなし(totalInScopeが2桁)", count: 30, limit: 10 },
    {
      name: "帯がentry_limitで切られる(totalInScopeが2桁)",
      count: 30,
      limit: 10,
      digestBandLimit: 5,
    },
    {
      name: "帯がentry_limitで切られる(totalInScopeが3桁)",
      count: 150,
      limit: 10,
      digestBandLimit: 5,
    },
  ];

  it.each(CLEAN_SCENARIOS)(
    "$name: 実際のusage.charsとestimateRecallFootprintの見積もりが完全一致する",
    async (sc) => {
      const [result, profile] = await Promise.all([recallFor(sc), profileFor()]);
      const est = estimateRecallFootprint(
        { memoryCountInScope: sc.count, limit: sc.limit, digestBandLimit: sc.digestBandLimit },
        profile,
      );
      expect(est.chars).toBe(result.usage.chars);
    },
  );

  /** 既知の残差: 帯が文字数上限で飽和する領域では、`estimateRecallFootprint` が件数の上限だけを見るため打ち切り位置が一致しない。「一致しないこと」自体を歯にして、直したふりをしない。 */
  it("既知の残差: 帯が文字数上限で飽和する領域では一致しない（既存の近似、本PRの対象外）", async () => {
    const sc: Scenario = { name: "飽和", count: 150, limit: 10, digestBandLimit: 200 };
    const [result, profile] = await Promise.all([recallFor(sc), profileFor()]);
    expect(result.index.digestBandCoverage?.limitedBy).toBe("char_budget");
    const est = estimateRecallFootprint(
      { memoryCountInScope: sc.count, limit: sc.limit, digestBandLimit: sc.digestBandLimit },
      profile,
    );
    expect(est.chars).not.toBe(result.usage.chars);
  });

  /** 既知の残差: 複数 group では構造項(b)の「単一 group で `groups[0].count === totalInScope`」が成り立たず、`RecallFootprintShape` が group の内訳を持たないので原理的に直せない。一致しないことを明示して残す。 */
  it("既知の残差: groupsが複数件のときは一致しない（shapeがgroup内訳を持たないため原理的に直せない）", async () => {
    const sc: Scenario = { name: "複数group", count: 6, limit: 10, multiGroup: true };
    const [result, profile] = await Promise.all([recallFor(sc), profileFor()]);
    expect(result.index.groups.length).toBeGreaterThan(1);
    const est = estimateRecallFootprint(
      { memoryCountInScope: sc.count, limit: sc.limit, digestBandLimit: sc.digestBandLimit },
      profile,
    );
    expect(est.chars).not.toBe(result.usage.chars);
  });

  /** `HOLD_IN_SCENARIOS` はすべて帯が空（`limit` が `count` 以上）にする: `calibrateRecallFootprint` が使えるのは `bandEntryCount === 0` の標本だけのため。 */
  it("較正の歯: 実recall()（1/2/3桁、帯なし）から footprintSampleFromRecall→calibrateRecallFootprint で較正すると、held-outの実測(帯ありを含む)と一致する", async () => {
    const HOLD_IN_SCENARIOS: Scenario[] = [
      { name: "帯なし(1桁)", count: 5, limit: 10 },
      { name: "帯なし(1桁,別件数)", count: 9, limit: 10 },
      { name: "帯なし(2桁)", count: 42, limit: 50 },
      { name: "帯なし(3桁)", count: 137, limit: 200 },
    ];
    const holdInResults = await Promise.all(HOLD_IN_SCENARIOS.map((sc) => recallFor(sc)));
    for (const result of holdInResults) {
      expect(result.index.digestBand).toEqual([]);
    }
    const samples = holdInResults.map((r) => footprintSampleFromRecall(r));
    expect(samples.some((s) => (s.totalInScope ?? 0) >= 10)).toBe(true);
    expect(samples.some((s) => (s.totalInScope ?? 0) >= 100)).toBe(true);

    const calibrated = calibrateRecallFootprint(samples);
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);

    expect(calibrated.charsPerDigest).toBeCloseTo(DIGEST_LEN, 6);

    for (const sc of CLEAN_SCENARIOS) {
      const result = await recallFor(sc);
      const est = estimateRecallFootprint(
        { memoryCountInScope: sc.count, limit: sc.limit, digestBandLimit: sc.digestBandLimit },
        calibrated,
      );
      expect(est.chars, `scenario=${sc.name}`).toBeCloseTo(result.usage.chars, 6);
    }
  });
});
