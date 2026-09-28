import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScoreBreakdown } from "@mnemora/core";
import type { ArmReport, ProbeOutcome } from "../retrieval-quality.js";
import {
  RANK_LISTING_FIXED_CLOCK_ISO,
  buildRankListing,
  decideRankListingExit,
  formatRankListingMarkdown,
} from "../retrieval-rank-listing.js";

/**
 * `retrieval-rank-listing`(Issue #572、ADR 0276 の 2026-09-28 の追記)の純関数の歯。DB 不要。
 *
 * ⭐ **いちばん守りたい契約は「順位がどうであっても exit 0」である**——この一覧は門ではない。
 * 逆向きに、**一覧を作れない(bench が壊れた)ときは非0**であることも同じ強さで固定する。
 * ⛔ 数値(実測の順位・スコア)は焼き込まない。ここで使う値はすべて合成である。
 */

function score(total: number): ScoreBreakdown {
  return { similarity: total, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total };
}

function makeProbe(
  id: string,
  opts: { goldRank: number | null; goldScore?: number; last?: number | null; rows?: number },
): ProbeOutcome {
  const rows = opts.rows ?? 10;
  return {
    probeId: id,
    lexicalControl: false,
    goldRank: opts.goldRank,
    distractorRank: null,
    hit1: opts.goldRank === 1,
    hit10: opts.goldRank !== null,
    distractorBeatsGold: false,
    reciprocalRank: opts.goldRank === null ? 0 : 1 / opts.goldRank,
    omittedKinds: [],
    totalInScope: 60,
    scoreDetails:
      opts.goldRank === null
        ? []
        : [
            {
              roles: ["gold"],
              rank: opts.goldRank,
              digest: "d",
              score: score(opts.goldScore ?? 0.5),
            },
          ],
    termSpreads: [],
    recalledRows: rows,
    lexicalMatchRows: 0,
    decayFreshnessRowwise: { rows, equalRows: rows, differentRows: 0 },
    lastRecalledScore: opts.last === undefined ? (rows > 0 ? 0.1 : null) : opts.last,
  };
}

function makeReport(probes: ProbeOutcome[]): ArmReport {
  return {
    armLabel: "rank-listing",
    tenantId: "t",
    llmMode: "recorded",
    embeddingMode: "recorded",
    ingest: {
      observationCount: 1,
      drain: { ticks: 1, totalProcessed: 1, totalFailed: 0, firstTickProcessed: 1 },
      extractionCounts: { ok: 1, skipped: 0, llmFailedWholeObservation: 0 },
      measurement: "measured",
      singleTickWouldHaveStalled: false,
    },
    probes,
    mrrOverall: 0,
    mrrLexicalControl: 0,
    mrrNonLexical: 0,
    usageReport: "",
    channels: ["ann"],
  };
}

describe("retrieval-rank-listing: 終了コードは順位を見ない(⛔ 門ではない)", () => {
  it("全 probe の gold が圏外でも、候補が返っていれば exit 0(門が赤になる状態でも一覧は落ちない)", () => {
    const listing = buildRankListing(
      makeReport([makeProbe("a", { goldRank: null }), makeProbe("b", { goldRank: null })]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    expect(decideRankListingExit(listing, 2)).toEqual({ exitCode: 0, reasons: [] });
  });

  it("順位が良くても悪くても混ざっていても exit 0", () => {
    const listing = buildRankListing(
      makeReport([
        makeProbe("a", { goldRank: 1 }),
        makeProbe("b", { goldRank: 10 }),
        makeProbe("c", { goldRank: null }),
      ]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    expect(decideRankListingExit(listing, 3).exitCode).toBe(0);
  });

  it("一部の probe だけ候補が0件でも exit 0(全 probe が0件のときだけが「壊れた」)", () => {
    const listing = buildRankListing(
      makeReport([makeProbe("a", { goldRank: null, rows: 0 }), makeProbe("b", { goldRank: 3 })]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    expect(decideRankListingExit(listing, 2).exitCode).toBe(0);
  });
});

describe("retrieval-rank-listing: 一覧を作れないときは非0(bench が壊れた)", () => {
  it("全 probe で候補が0件なら exit 1(固定時刻を過去に倒したときの踏み間違い)", () => {
    const listing = buildRankListing(
      makeReport([
        makeProbe("a", { goldRank: null, rows: 0 }),
        makeProbe("b", { goldRank: null, rows: 0 }),
      ]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    const decided = decideRankListingExit(listing, 2);
    expect(decided.exitCode).toBe(1);
    expect(decided.reasons).toHaveLength(1);
    expect(decided.reasons[0]).toContain("候補が0件");
  });

  it("probe の件数が期待と違えば exit 1(一覧が欠けている)", () => {
    const listing = buildRankListing(
      makeReport([makeProbe("a", { goldRank: 1 })]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    const decided = decideRankListingExit(listing, 2);
    expect(decided.exitCode).toBe(1);
    expect(decided.reasons[0]).toContain("件数");
  });

  it("probe が0件なら exit 1(件数が期待と違う)", () => {
    const listing = buildRankListing(makeReport([]), RANK_LISTING_FIXED_CLOCK_ISO);
    expect(decideRankListingExit(listing, 7).exitCode).toBe(1);
  });
});

describe("retrieval-rank-listing: 一覧の中身", () => {
  it("gold のスコアは scoreDetails の gold から取り、gold − 最下位を出す", () => {
    const listing = buildRankListing(
      makeReport([makeProbe("a", { goldRank: 6, goldScore: 0.3, last: 0.25 })]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    const [row] = listing.probes;
    expect(row).toMatchObject({
      probeId: "a",
      goldRank: 6,
      goldScore: 0.3,
      lastRecalledScore: 0.25,
    });
    expect(row!.goldMinusLast).toBeCloseTo(0.05, 12);
  });

  it("gold が圏外なら gold のスコアと差は null(0 を捏造しない)", () => {
    const listing = buildRankListing(
      makeReport([makeProbe("a", { goldRank: null })]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    expect(listing.probes[0]).toMatchObject({ goldScore: null, goldMinusLast: null });
  });

  it("Markdown に全 probe の行が載り、門ではないと名乗る", () => {
    const listing = buildRankListing(
      makeReport([makeProbe("alpha", { goldRank: 2 }), makeProbe("beta", { goldRank: null })]),
      RANK_LISTING_FIXED_CLOCK_ISO,
    );
    const md = formatRankListingMarkdown(listing);
    expect(md).toContain("| alpha | 2 |");
    expect(md).toContain("| beta | 圏外 |");
    expect(md).toContain("門ではない");
  });
});

describe("retrieval-rank-listing: 門と同じ条件で測っていること", () => {
  it("固定時刻が、門(retrieval-quality-regression.postgres.test.ts)の固定時刻と同じ", () => {
    const gate = readFileSync(
      fileURLToPath(new URL("./retrieval-quality-regression.postgres.test.ts", import.meta.url)),
      "utf-8",
    );
    expect(gate).toContain(`fixedClock(new Date("${RANK_LISTING_FIXED_CLOCK_ISO}"))`);
  });
});
