import type { ArmReport } from "./retrieval-quality.js";

/**
 * 固定回帰ケース(ADR 0227 の門)と同じ条件で、probe ごとの順位を一覧にする(Issue #572、
 * ADR 0276 の 2026-09-28 の追記)。**門ではない**——順位がどうであっても落とさない。
 *
 * ⭐ **なぜ要るか**: ADR 0227 の門(`retrieval-quality-regression.postgres.test.ts`)は
 * `goldRank !== null` だけを見て、順位を出力しない。`retrieval-quality` ジョブは probe ごとの
 * 順位を生ログに出すが、実時計で走るので門と条件が違う。⟹ **門が見ているのと同じ条件の
 * 順位を、PR の Checks から読める場所に出す口が無かった。**Issue #572 が実測した
 * 「`diet` の gold はスコアで紙一重」も、この一覧なら gold と最下位候補のスコア差として見える。
 *
 * ⛔ **基準値とは比べない。**順位・スコアを基準値ファイルへ焼き込まず、その場で出すだけにする
 * (ADR 0227 が順位を焼き込まなかった理由と同じ。`AGENTS.md`「⚠ 数を、道具と生成物に
 * 焼き込まない」)。
 *
 * **非0で終わるのは、bench そのものが壊れて一覧を作れないときだけ**
 * (`decideRankListingExit`)。例外(カセットに無い入力・DB エラー)は呼び出し側で
 * そのまま非0になる。
 */

/**
 * 門(`retrieval-quality-regression.postgres.test.ts`)が使う固定時刻と同じ値。
 * ⚠ 門のほうは値をテスト内に直に書いている(門のファイルは1バイトも変えない、という
 * この追加の条件による)。**片方だけ変えると、この一覧は門と別の条件を測り始める**——
 * `retrieval-rank-listing.test.ts` が門のファイルの文字列と突き合わせる。
 */
export const RANK_LISTING_FIXED_CLOCK_ISO = "2030-01-01T00:00:00.000Z";

export const RANK_LISTING_SCHEMA_VERSION = 1;

export interface RankListingProbeRow {
  probeId: string;
  /** gold の順位(1始まり)。既定の limit の外なら null(門が赤になる状態)。 */
  goldRank: number | null;
  distractorRank: number | null;
  /** gold の `score.total`。gold が返らなければ null。 */
  goldScore: number | null;
  /** 返った候補のうち最下位の `score.total`。候補が0件なら null。 */
  lastRecalledScore: number | null;
  /** `goldScore − lastRecalledScore`。どちらかが null なら null。 */
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
      const goldScore = gold ? gold.score.total : null;
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
  /** 非0にした理由。exitCode が 0 なら空。 */
  reasons: string[];
}

/**
 * 終了コードを決める。**順位は見ない。**
 *
 * 非0にするのは次の2つだけである:
 * - probe の件数が `expectedProbeCount`(呼び出し側が `PROBES.length` から渡す)と違う
 *   ——一覧が欠けている。
 * - **全 probe で候補が0件**——一覧に順位が1つも載らない。門のファイル doc が書いている
 *   `fixedClock` を過去に倒したときの踏み間違い(embed ジョブが claim されず、例外にならずに
 *   全 probe が空になる)がこれに当たる。
 *
 * ⛔ gold が圏外(`goldRank === null`)の probe が在っても、それだけでは 0 のままである
 * ——それを赤にするのは門の役目であり、この一覧の役目ではない。
 */
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

/** Job Summary 用の Markdown。 */
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
