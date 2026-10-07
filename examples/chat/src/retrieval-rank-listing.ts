import type { ArmReport } from "./retrieval-quality.js";
import { scoreTotalOrNull } from "./recalled-score.js";

/** 門ではない: 順位がどうであっても落とさない。基準値とも比べない（順位・スコアを基準値ファイルへ焼き込まない）。 */

// 門 `retrieval-quality-regression.postgres.test.ts` がテスト内に直書きする固定時刻と同じ値。片方だけ変えると、この一覧は門と別の条件を測り始める。
export const RANK_LISTING_FIXED_CLOCK_ISO = "2030-01-01T00:00:00.000Z";

export const RANK_LISTING_SCHEMA_VERSION = 1;

export interface RankListingProbeRow {
  probeId: string;
  goldRank: number | null;
  distractorRank: number | null;
  goldScore: number | null;
  lastRecalledScore: number | null;
  goldMinusLast: number | null;
  recalledRows: number;
}

export interface RankListingJson {
  schemaVersion: number;
  conditions: {
    llmMode: string;
    embeddingMode: string;
    fixedClock: string;
  };
  probes: RankListingProbeRow[];
}

export function buildRankListing(report: ArmReport, fixedClock: string): RankListingJson {
  return {
    schemaVersion: RANK_LISTING_SCHEMA_VERSION,
    conditions: {
      llmMode: report.llmMode,
      embeddingMode: report.embeddingMode,
      fixedClock,
    },
    probes: report.probes.map((p) => {
      const gold = p.scoreDetails.find((d) => d.roles.includes("gold"));
      const goldScore = gold ? scoreTotalOrNull(gold.score) : null;
      const lastRecalledScore = p.lastRecalledScore ?? null;
      return {
        probeId: p.probeId,
        goldRank: p.goldRank,
        distractorRank: p.distractorRank,
        goldScore,
        lastRecalledScore,
        goldMinusLast:
          goldScore !== null && lastRecalledScore !== null ? goldScore - lastRecalledScore : null,
        recalledRows: p.recalledRows,
      };
    }),
  };
}

export interface RankListingExit {
  exitCode: 0 | 1;
  reasons: string[];
}

/** 順位は見ない。gold が圏外の probe が在っても 0 のまま（赤にするのは門の役目）。 */
export function decideRankListingExit(
  listing: RankListingJson,
  expectedProbeCount: number,
): RankListingExit {
  const reasons: string[] = [];
  if (listing.probes.length !== expectedProbeCount) {
    reasons.push(
      `probe の件数が ${listing.probes.length} で、期待した ${expectedProbeCount} と違う(一覧が欠けている)`,
    );
  }
  if (listing.probes.length > 0 && listing.probes.every((p) => p.recalledRows === 0)) {
    reasons.push(
      "全 probe で recall() の候補が0件だった(embed ジョブが処理されていない可能性。固定時刻が過去になっていないか)",
    );
  }
  return { exitCode: reasons.length === 0 ? 0 : 1, reasons };
}

function formatRank(rank: number | null): string {
  return rank === null ? "圏外" : String(rank);
}

function formatScore(value: number | null): string {
  return value === null ? "-" : value.toFixed(6);
}

export function formatRankListingMarkdown(listing: RankListingJson): string {
  const rows = listing.probes.map(
    (p) =>
      `| ${p.probeId} | ${formatRank(p.goldRank)} | ${formatRank(p.distractorRank)} | ` +
      `${formatScore(p.goldScore)} | ${formatScore(p.lastRecalledScore)} | ` +
      `${formatScore(p.goldMinusLast)} | ${p.recalledRows} |`,
  );
  return [
    "# 固定回帰ケースと同じ条件での、probe ごとの順位(Issue #572。⛔ 門ではない)",
    "",
    `条件: llm=${listing.conditions.llmMode} / embedding=${listing.conditions.embeddingMode} / ` +
      `固定時刻=${listing.conditions.fixedClock} / probe=\`probe-set.ts\` の \`PROBES\``,
    "",
    "| probe | gold の順位 | distractor の順位 | gold のスコア | 最下位候補のスコア | gold − 最下位 | 候補数 |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "⚠ **この一覧は門ではない。**順位がどうであってもこのジョブは落ちない。落ちるのは bench が" +
      "壊れて一覧を作れないときだけである。門は `examples/chat` ジョブの " +
      "`retrieval-quality-regression.postgres.test.ts`(gold が既定の候補に入っているか)のまま変えていない。",
    "",
    "⚠ **基準値とは比べていない。**前の値と比べるときは、前の run の成果物 `retrieval-rank-listing` を見ること。",
  ].join("\n");
}
