import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
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

/**
 * `recall-footprint`（Issue #276）の歯。**DB もネットワークも要らない、純関数の検査のみ。**
 */

// ---------------------------------------------------------------------------
// 構造定数のずれを検知する歯（オーナー側から明示的に求められたもの）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// estimateRecallFootprint — 境界
// ---------------------------------------------------------------------------

/**
 * この節専用のテスト用プロファイル。**BUILTIN の実測値ではなく、境界の算術だけを検査する。**
 * charsPerDigest=100（DIGEST_BAND_MAX_ENTRY_CHARS=120 未満なので切り詰めは起きない）にして、
 * DEFAULT_DIGEST_BAND_LIMIT 件（50件）で確実に DIGEST_BAND_MAX_CHARS（4000字）へ当たるようにする
 * （50 × (63+1+100) = 8200 ≫ 4000）。
 */
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

/**
 * ⚠ **主張を Issue #340（構造項、comment 5822837148）に合わせて言い直した歯**
 * （元は「chars は完全に頭打ちで1バイトも動かない」という厳密な等値だったが、それは
 * 誤りだった——`totalInScope`/`digestBandCoverage.eligible` は帯自体が飽和していても
 * `JSON.stringify` 上の桁数が伸び続ける（構造項(b)/(c)、`O(log memoryCountInScope)`）。
 * 帯（`bandEntries`・`byTier.digest`）と較正済みの2係数はここでも変わらないままで、
 * **増える分は桁上がり構造項だけに限られる**——それを式から独立に導いて厳密一致で
 * 検査する（数値を実測値へ貼り替えたのではなく、主張そのものを構造から導く形に直した）。
 */
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
    // 返る件数・帯の件数は、それぞれ limit / bandLimit で頭打ちになっているので同じ。
    expect(b.returnedMemories).toBe(a.returnedMemories);
    expect(b.bandEntries).toBe(a.bandEntries);
    // digest tier は returnedMemories だけで決まるので、完全に不変（頭打ちの核はここ）。
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

    // 事前計算(検算用のドキュメント): 2×(5-2) + (1-1) + (4-1) = 6 + 0 + 3 = 9。
    expect(expectedCharsDiff).toBe(9);
    expect(b.byTier.index - a.byTier.index).toBe(expectedCharsDiff);
    expect(b.chars - a.chars).toBe(expectedCharsDiff);
  });
});

// ---------------------------------------------------------------------------
// associationCount（ADR 0166）— 連想枠の項
// ---------------------------------------------------------------------------

/**
 * ⭐ **後方互換の歯**（ADR 0166、オーナーが名指しで要求したもの）。
 *
 * `shape.associationCount` を**渡さない**呼び出しは、ADR 0166 より前と
 * 1ビットも変わらないことを、`toEqual` で丸ごと検査する
 * ——特定の欄だけを見比べると、見落とした欄が静かに変わっていても気づけない。
 */
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
      // associationCount を渡していないのだから、昇格は起きていない。
      expect(omitted.associationCount).toBe(0);
    },
  );

  /**
   * ⚠ **主張を Issue #340（構造項、comment 5822837148）に合わせて言い直した歯**
   * （元は「ADR 0166 以前の式（構造項を1つも知らない素朴な式）と一致する」だったが、
   * それは Issue #340 で正しく直った側と食い違うようになった——だが崩れたのは
   * 「association を渡さない後方互換」の主張ではなく、**この複製が構造項を知らない**
   * ことのほうである。ADR 0166 が守っている本質（`returnedMemories`/`bandEntries` の
   * 決め方——association を考慮しない `min(limit, memoryCountInScope)` 系の式——は
   * このテストの `for` ループが個別に検査しており、今も揺らいでいない）。
   *
   * ⟹ **複製した式のほうに Issue #340 の構造項を足して**、実装が「ADR 0166 の
   * association 非対応の骨格」と「Issue #340 の構造項」の両方を正しく組み合わせて
   * いることを、独立な再実装との一致で検算する形に直した（数値を実測値へ貼り替えた
   * のではなく、複製した式のほうを実装の現在の姿に追随させた——`shapeTestProfile`・
   * `shapesWithoutAssociation` はどちらも変えていない）。
   */
  it("省略時の見積もりは、ADR 0166 以前の式（association 非対応）に Issue #340 の構造項を足したものと一致する", () => {
    // ADR 0166 以前の式（association を知らない）に、Issue #340 の構造項(a)〜(d)を
    // 実装から独立に足して複製する。
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

      // Issue #340 の構造項。`recall-footprint.ts` の実装と同じ式を、独立に複製する
      // （このファイルの他の歯・上の「帯が飽和した後」の歯と同じ作法）。
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
      // ⭐ ADR 0166 の骨格（association を考慮しない returnedMemories/bandEntries の
      // 決め方）は、この個別の一致で今も検査され続けている。
      expect(actual.returnedMemories).toBe(expected.returnedMemories);
      expect(actual.bandEntries).toBe(expected.bandEntries);
      expect(actual.chars).toBe(expected.chars);
    }
  });
});

describe("estimateRecallFootprint — associationCount（連想枠が本体へ昇格させた件数）", () => {
  it("帯が件数で飽和していない領域では、昇格1件ごとに『帯の1件』が『本体の1件』に置き換わる", () => {
    // shapeTestProfile: charsPerDigest=100, fixedIndexChars=100。
    // memoryCountInScope=30, limit=10 ⟹ 素の返る件数=10、帯資格=20（bandLimit=50未満、非飽和）。
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

    // 1件あたり: 帯の費用(63+1+min(100,120)=164) が消え、本体の費用(charsPerDigest=100) が増える。
    // 差は 3 × (100 - 164) = -192（正味で減る）。
    expect(withAssociation.chars).toBe(without.chars - 3 * 64);
  });

  it("帯が件数で既に飽和している領域では、昇格は帯の費用を減らさず、本体側の費用だけ純増する", () => {
    // memoryCountInScope=100, limit=10 ⟹ 帯資格=90 > bandLimit(50) ⟹ 帯は件数で頭打ち。
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
    // memoryCountInScope=12, limit=10 ⟹ limit の外は2件しかいない。
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

// ---------------------------------------------------------------------------
// calibrateRecallFootprint — 3階建て
// ---------------------------------------------------------------------------

describe("calibrateRecallFootprint — 3階建て", () => {
  it("(a) memoryCount が2種類以上ある帯なし標本 → borrowedFromDefault は空（両係数とも標本から決まる）", () => {
    // totalChars = 100 + 40 * memoryCount という厳密な線形標本。
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

  it("⭐ (a) と (c) は origin.kind だけでは区別できないが、borrowedFromDefault で分岐できる", () => {
    const allDataDriven = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    const noneUsable = calibrateRecallFootprint([
      { totalChars: 900, memoryCount: 10, bandEntryCount: 3 },
    ]);

    // どちらも kind は同じ "calibrated"。ここだけを見ると区別が付かない。
    expect(allDataDriven.origin.kind).toBe("calibrated");
    expect(noneUsable.origin.kind).toBe("calibrated");

    if (allDataDriven.origin.kind !== "calibrated" || noneUsable.origin.kind !== "calibrated") {
      throw new Error("unreachable");
    }
    // borrowedFromDefault を見れば、全データ駆動か、全部既定値借用かが完全に分かれる。
    expect(allDataDriven.origin.borrowedFromDefault).toEqual([]);
    expect(noneUsable.origin.borrowedFromDefault).toEqual(["charsPerDigest", "fixedIndexChars"]);
  });
});

// ---------------------------------------------------------------------------
// calibrateRecallFootprint — 構造項を差し引く（Issue #340 フォローアップ / ADR 0306）
//
// `estimateRecallFootprint` は `indexBand` の JSON 構造から決まる4つの構造項
// （ADR 0302）を足す。ADR 0302 の hold-in 標本（`compare-baseline.json` の7行）は
// すべて `totalInScope` が1桁だったので、この構造項は較正の段階では常に0であり、
// 較正係数（`charsPerDigest`/`fixedIndexChars`）には混ざっていなかった。
//
// `totalInScope` が2桁以上の標本を較正に混ぜると、この前提が崩れる——桁上がり分が
// 最小二乗の線形式（`totalChars = fixedIndexChars + memoryCount * charsPerDigest`）に
// そのまま混ざり、係数が偏る。**その係数の上に、`estimateRecallFootprint` が同じ
// 構造項をもう一度足す**ので、二重計上になる。
//
// この節は、**既知の真の係数**から構造項込みの合成標本を作り、
// 「`totalInScope` を渡さなければ偏る／渡せば真の係数に戻る」ことを直接示す。
// ---------------------------------------------------------------------------

describe("calibrateRecallFootprint — 構造項を差し引く（Issue #340 フォローアップ / ADR 0306）", () => {
  /**
   * 既知の真の係数。**standard な値ではなく、丸め誤差と区別しやすいよう小数を選んだ。**
   */
  const TRUE_CHARS_PER_DIGEST = 12.3;
  const TRUE_FIXED_INDEX_CHARS = 200.7;

  /** テスト用の桁上がり計算——実装の `extraDigitsBeyondOne` とは独立に、素朴に数える。 */
  function extraDigitsBeyondOneForTest(n: number): number {
    return Math.max(0, String(n).length - 1);
  }

  /**
   * `totalInScope=n` の合成標本を作る。**`memoryCount = n`（全件を返す想定）にして
   * `bandEligible = totalInScope - memoryCount = 0` を保証する**——帯が常に空になり
   * (a)カンマ/(d)limitedBy の構造項は常に0、効くのは(b)の桁上がりだけになる
   * （`estimateRecallFootprint` が実際に計算する式と同じ形——本ブロックの前提節参照）。
   *
   * `totalChars` は「真の係数から決まる非構造の線形部分 + 構造項」として合成する——
   * これは `estimateRecallFootprint` が既に主張している式そのものであり
   * （`estimateRecallFootprint` の doc、構造項(b)）、ここで新しいモデルを持ち込んでは
   * いない。
   */
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

  // 1桁×2・2桁×2・3桁×2を混ぜる。
  const SCOPE_COUNTS = [4, 8, 55, 91, 137, 480];

  it("totalInScope を渡さなければ、2桁/3桁標本の桁上がりが係数に混ざり、真の係数から有意にずれる", () => {
    const samples = SCOPE_COUNTS.map((n) => syntheticSample(n, false));
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    // 【実測】(この歯を書いた時点、fix適用前後とも同じ合成標本で検算): 偏りは
    // charsPerDigest で約+0.00754、fixedIndexChars で約+1.026——浮動小数点の丸め
    // （1e-10のオーダー）よりずっと大きい。ここでは丸めとの取り違えを避けるため
    // 十分小さい閾値(1e-4)だけを歯にする。
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

  it("totalInScope を省略した標本は、構造項0として扱われる（既定値と1バイトも変わらない後方互換）", () => {
    // 1桁のみの標本では、そもそも構造項が常に0なので、渡しても渡さなくても
    // 結果は変わらないはず——後方互換の直接確認。
    const singleDigitCounts = [3, 5, 7];
    const withField = singleDigitCounts.map((n) => syntheticSample(n, true));
    const withoutField = singleDigitCounts.map((n) => syntheticSample(n, false));
    const profileWith = calibrateRecallFootprint(withField);
    const profileWithout = calibrateRecallFootprint(withoutField);
    expect(profileWith.charsPerDigest).toBe(profileWithout.charsPerDigest);
    expect(profileWith.fixedIndexChars).toBe(profileWithout.fixedIndexChars);
  });

  it("2桁/3桁を含む標本でも、totalInScope を省略した呼び出し1本の結果はこれまでの実装と同じ式で再現できる（回帰防止）", () => {
    // 「省略時は構造項0」という契約を、このテストファイル内の別の場所（3階建てテスト等）
    // が使っている素朴な標本（totalInScope 無し）でも壊していないことの確認。
    const samples: RecallFootprintSample[] = [
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 700, memoryCount: 15, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    // 素朴な厳密線形標本 (totalChars = 100 + 40*memoryCount) と同じ値——
    // totalInScope を持たないので構造項の差し引きは一切効かない。
    expect(profile.charsPerDigest).toBeCloseTo(40, 9);
    expect(profile.fixedIndexChars).toBeCloseTo(100, 9);
  });
});

// ---------------------------------------------------------------------------
// compareWithFullLog
// ---------------------------------------------------------------------------

describe("compareWithFullLog — reasons は空にならない", () => {
  it("較正済みプロファイルでも、較正した範囲の外を尋ねれば outside_calibrated_range が立つ（空にならない）", () => {
    const calibrated = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    // 較正の observedMemoryCount は {min:5, max:10}。100 はその外側 ⟹ extrapolated。
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

  /**
   * ⭐ **この歯が、本体のバグを1件見つけた**【実測】。
   *
   * 当初 `FullLogComparison.reasons` の doc は「空にならない（**少なくとも出所に関する札が
   * 1枚は立つ**）」と書いていたが、それは誤りだった——較正済み(`kind: "calibrated"`)・
   * `borrowedFromDefault` が空・較正範囲の内側(`extrapolated === false`)・帯が非飽和・
   * 件数が非切り詰め・`estimatedShare` が許容誤差の外、が重なると出所の札も量の札も
   * 1枚も立たず、`reasons` は**空配列**で返っていた。
   *
   * **doc ではなく実装のほうを直した**——`dominant_term`（見積もりの支配項）を常に
   * 立てる形にし、非空を構造的に保証した。**空の `reasons` は「この判定の理由を1つも
   * 説明できない」ことであり、doc を緩めて済ませてよい種類の食い違いではない**
   * （北極星の問い3「説明できない賢さは採らない」）。
   *
   * ⟹ **この歯は、その回帰を止めるためにここに在る。**
   */
  it("出所の札も量の札も1枚も立たない条件でも、dominant_term が立って reasons は空にならない", () => {
    const calibrated = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    // memoryCountInScope=8 は observedMemoryCount {min:5,max:10} の内側 ⟹ extrapolated=false。
    // limit=10(既定)なので capped もされず、帯も飽和しない。
    // chars = 100(fixedIndexChars) + 8*40(charsPerDigest) = 420。420/1000=0.42 は
    // 既定許容誤差(0.05)の外 ⟹ within_tolerance も立たない。
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 8 },
      profile: calibrated,
    });
    expect(result.verdict).toBe("mnemora_smaller");
    // ⭐ かつてここが空配列だった。
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.map((r) => r.code)).toEqual(["dominant_term"]);
    // 8件 × 40字 = 320字（memories）> 100字（fixed_index）> 0字（帯なし）。
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
    // memoryCountInScope=10, limit=既定(10) ⟹ 帯は空。digest tier = 10 * 10 = 100。
    //
    // ⚠ **主張を Issue #340（構造項、comment 5822837148）に合わせて言い直した歯**
    // （元は「chars は厳密に100」という決め打ちだったが、それは誤りだった——
    // `totalInScope=10` は最初から2桁であり、構造項(b)（`totalInScope`・単一group想定の
    // `groups[0].count`の桁上がり、2×(桁数-1)=2×1=+2）が乗るので実際は102になる。
    // この歯が検査したい本質は「境界（許容誤差の内と外）を正しくまたぐか」であって
    // 「100という特定の数値」ではないので、期待値そのものを構造項込みの式から導く
    // 形に直した——数値を実測値へ貼り替えたのではなく、主張を構造から導いている）。
    function extraDigitsBeyondOne(n: number): number {
      return Math.max(0, String(Math.max(0, Math.trunc(n))).length - 1);
    }
    const expectedChars =
      10 * profile.charsPerDigest + profile.fixedIndexChars + 2 * extraDigitsBeyondOne(10);
    const est = estimateRecallFootprint({ memoryCountInScope: 10 }, profile);
    expect(est.chars).toBe(expectedChars); // = 100 + 0 + 2 = 102

    // fullLogChars は est.chars（構造項込みの見積もり）の1.03倍から導く——
    // 「103」という固定の実測値ではなく、見積もりに対して常に約3%上振れた値にする
    // ことで、est.chars が今後動いても「境界内(許容誤差5%の内側)にいる」という
    // この歯の意図がそのまま保たれる。
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

// ---------------------------------------------------------------------------
// footprintSampleFromRecall
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// estimateRecallFootprint — 構造項（Issue #340 comment 5822837148 / 本 PR）
//
// `BUILTIN_RECALL_FOOTPRINT_PROFILE`（および `examples/chat/compare-baseline.json`
// の hold-in 7行）は「目次帯が空・totalInScope/shown/eligible がすべて1桁」という
// 特定の形からしか較正していない。その形から外れたときに実際の `recall()` の
// `usage.chars`（= `JSON.stringify(indexBand)` の実バイト数を含む）と
// `estimateRecallFootprint` の見積もりがどれだけずれるかを、in-memory の runtime
// （`runtime-fakes.ts`、`@mnemora/testkit` には依存しない——このファイル群の作法）で
// 実際に `recall()` を呼んで検算する。
//
// **DB もネットワークも要らない**——`createFakeRuntimeStores()` が組む in-memory 実装
// に対して、`digest` の長さを固定した Memory を作り、`estimateRecallFootprint` に
// 渡すプロファイルの `charsPerDigest` をその固定長に、`fixedIndexChars` を
// 「帯が空・1桁」の基準シナリオで実測した値に、それぞれ合わせる
// ——そうすれば残りの差はすべて構造項（帯のカンマ・桁上がり・limitedBy）だけになる。
// ---------------------------------------------------------------------------

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
   * `FakeMemoryStore`（`runtime-fakes.ts`）は id を `mem-<counter>` で振るため桁数が
   * テスト内で伸び縮みする——本物（Postgres）は常に36字の UUID であり、
   * `DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS`（63）はその36字を前提に実測した定数
   * である。ここで id を強制的に36字へ揃えないと、id の桁の伸びという、この歯が
   * 検査したい構造差とは無関係なノイズが紛れ込む。
   *
   * `FakeMemoryStore` の `backing` は TS 上は private だが実行時にはただのプロパティ
   * なので、id を振り直すためだけにここで直接触る（このファイル内でしか使わない）。
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
      // association: null — 連想枠は既定 on（ADR 0337）。この歯は footprint の構造項
      // （帯・group・切り詰め）だけを検査する対象であり、連想が本体へ何件昇格するかは
      // recall-footprint.ts の associationCount と同じ理由でこの歯の対象外——連想を
      // 明示的に止めて基準線（構造項の実測値）を動かさない。
      association: null,
    });
  }

  /**
   * 基準シナリオ（帯が空・単一 group・totalInScope が1桁）で実測した `usage.chars` を、
   * このブロックの `profile.fixedIndexChars` として使う。この形は
   * `BUILTIN_RECALL_FOOTPRINT_PROFILE` の hold-in 標本（`totalInScope <=
   * DEFAULT_RECALL_LIMIT` の7行、いずれも帯が空で1桁）と同じ形であり、
   * ここでの構造項（すべてこの形からの「ずれ」として定義される）の基準点と一致する。
   */
  const REFERENCE: Scenario = { name: "基準(帯なし・単一group・1桁)", count: 5, limit: 10 };

  it("基準シナリオでは fixedIndexChars をそのまま実測できる（帯なし・1桁なので構造項はすべて0）", async () => {
    const result = await recallFor(REFERENCE);
    // 帯が空・単一group・1桁 ⟹ どの構造項も効かない（このテストファイル冒頭の前提）。
    expect(result.index.digestBand).toEqual([]);
    expect(result.index.groups).toHaveLength(1);
    expect(result.index.totalInScope).toBeLessThan(10);
    expect(result.index.digestBandCoverage?.shown).toBeLessThan(10);
    expect(result.index.digestBandCoverage?.eligible).toBeLessThan(10);
  });

  // 基準シナリオの実測値。上のテストが「本当に基準の形か」を検査している。
  // ⚠ 値そのものは実装(recall-runtime.ts / digest-band.ts)の構造定数から決まる
  // 実測値であり、ここで書き換えて歯を通すためのものではない
  // ("なぜ191か"は下の `beforeAll` 相当の実測から来ている——`it.concurrent` は使わず
  // 各テストが自分で `recallFor` を呼んで実測し直す)。

  /**
   * 構造項だけを検査するためのプロファイル。
   * - `charsPerDigest` は固定した digest 長そのもの（切り詰めは起きない長さ）。
   * - `fixedIndexChars` は基準シナリオの実測（band=0・単一group・1桁）。
   *   `calibrateRecallFootprint` を経由しない直書きだが、値の出所は実測であり
   *   歯の中で毎回検算する（下の `describe.each` の1本目が基準シナリオを兼ねる）。
   */
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

  /**
   * ⭐ 本体の歯: 単一 group・帯が飽和していない（`DIGEST_BAND_MAX_CHARS` に当たらない）
   * 領域では、実際の `usage.chars` と `estimateRecallFootprint` の見積もりが
   * **構造上ぴったり一致する**はずである（残差はすべて構造項として説明済みのため）。
   *
   * 実装前（構造項を足す前）はここが赤くなる——赤くなった実測は本 PR のコミットログ・
   * 報告に記録してある(WIP コミット → 実装 → 緑、の順)。
   */
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

  /**
   * ⚠ 既知の残差・その1: 目次帯が**文字数上限**（`DIGEST_BAND_MAX_CHARS`）で
   * 飽和する領域では、`estimateRecallFootprint` の `帯の件数`
   * （`min(digestBandLimit, bandEligible)`——件数の上限だけを見る）が、実際の
   * `packDigestBand`（文字数の上限にも当たったらそこで打ち切る）の打ち切り位置と
   * 一致しない。これは本 PR が対象にする4つの構造項とは別の、既存の近似
   * （`RecallFootprintEstimate.bandSaturated` の doc）であり、本 PR では直さない。
   * ⟹ ここでは「一致しないこと」自体を歯にして、直したふりをしない。
   */
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

  /**
   * ⚠ 既知の残差・その2: `groups` が複数件になる場合、`totalInScope` の桁上がり項
   * （構造項(b)）は「単一 group で `groups[0].count === totalInScope`」を仮定しており、
   * 複数 group では成り立たない。`RecallFootprintShape` は group の内訳を持たない
   * （持たせると公開シグネチャが変わる——本 PR の制約）ため、`estimateRecallFootprint`
   * からは原理的に直せない。ここでは「一致しないこと」を明示し、将来
   * `RecallFootprintShape` を拡張する判断の材料として残す。
   */
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

  /**
   * ⭐ 較正側の歯（Issue #340 フォローアップ / ADR 0306）: `footprintSampleFromRecall` で
   * **実際の `recall()`（1桁・2桁・3桁の `totalInScope`、すべて帯が空）**から標本を取り、
   * `calibrateRecallFootprint` で較正し、その較正済みプロファイルが
   * **held-out シナリオ**（帯が非空のものを含む）の実測 `usage.chars` と一致することを示す。
   *
   * `HOLD_IN_SCENARIOS` はすべて帯が空（`limit` が `count` 以上）になるよう選んである
   * ——`calibrateRecallFootprint` が使えるのはその形の標本だけであるため
   * （`calibrateRecallFootprint` の doc「使うのは bandEntryCount === 0 の標本だけ」）。
   * 2桁・3桁を混ぜているのが本 PR 以前との違いである——**総本 PR 以前は `totalInScope` を
   * 標本が持たなかったので、この較正は桁上がり分を係数に吸い込んでいた。**
   */
  it("較正の歯: 実recall()（1/2/3桁、帯なし）から footprintSampleFromRecall→calibrateRecallFootprint で較正すると、held-outの実測(帯ありを含む)と一致する", async () => {
    const HOLD_IN_SCENARIOS: Scenario[] = [
      { name: "帯なし(1桁)", count: 5, limit: 10 },
      { name: "帯なし(1桁,別件数)", count: 9, limit: 10 },
      { name: "帯なし(2桁)", count: 42, limit: 50 },
      { name: "帯なし(3桁)", count: 137, limit: 200 },
    ];
    const holdInResults = await Promise.all(HOLD_IN_SCENARIOS.map((sc) => recallFor(sc)));
    for (const result of holdInResults) {
      // この歯の前提: 帯が実際に空であること(calibrateRecallFootprintが使う条件)。
      expect(result.index.digestBand).toEqual([]);
    }
    const samples = holdInResults.map((r) => footprintSampleFromRecall(r));
    // 2桁・3桁の totalInScope が実際に混ざっていること(この歯が検算したい形)。
    expect(samples.some((s) => (s.totalInScope ?? 0) >= 10)).toBe(true);
    expect(samples.some((s) => (s.totalInScope ?? 0) >= 100)).toBe(true);

    const calibrated = calibrateRecallFootprint(samples);
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);

    // 較正した digest 長は、実際に固定した DIGEST_LEN と一致するはず——
    // 構造項を正しく差し引けていれば、桁上がりに惑わされず真の傾きが出る。
    expect(calibrated.charsPerDigest).toBeCloseTo(DIGEST_LEN, 6);

    // held-out: CLEAN_SCENARIOS(帯ありを含む)の実測と、この較正済みプロファイルの
    // 見積もりが一致することを確認する。
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
