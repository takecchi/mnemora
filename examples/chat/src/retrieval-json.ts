import type { RecallChannel } from "@mnemora/core";
import type { Cassette } from "@mnemora/testkit";
import type { ProviderMode } from "./providers.js";
import { armHeadline } from "./retrieval-quality.js";
import type { ArmReport, ArmTermDistinct } from "./retrieval-quality.js";

/**
 * `retrieval` の機械可読な出力口。ファイル I/O を持たない純関数のまま保ち、DB なしで検査できるようにする（書くのは `cli.ts`）。
 * 数字だけで条件を書かない出力は壊れるので、arm ごとに実際に使われた `llmMode`/`embeddingMode` を同居させ、
 * 実行全体にも provider source・カセットの `recordedAt`・埋め込み空間などを同居させる。
 * 出所は `ArmReport` と `armHeadline()` だけにする——表示用の文字列とこの JSON が別々に集計して食い違う経路を構造上閉じるため。
 * `mrrLexicalControl`/`mrrNonLexical` は `armHeadline` が持っていないので、`report` から直接読む。
 */

export interface RetrievalQualityArmJson {
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  mrrOverall: number;
  mrrLexicalControl: number;
  mrrNonLexical: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  /**
   * 省略可能欄にした理由: 既存の欄の意味を変えない追加なので `schemaVersion` は上げず、この欄を持たない古い実測 JSON・
   * `retrieval-baseline.json` を読む側（`validateMeasured`/`validateBaseline`）が通り続けるようにする。
   */
  lexicalMatchRows?: number;
  recalledRows?: number;
  /**
   * 省略可能欄にした理由は `lexicalMatchRows` と同じ。JSON は数値を丸めずに書く: 1e-7 桁の `decay`/`freshness` の差を
   * 機械可読に残す唯一の経路のため。
   */
  termDistinct?: ArmTermDistinct[];
  decayFreshnessEqualRows?: number;
  decayFreshnessDifferentRows?: number;
  /** 省略可能欄にした理由は `lexicalMatchRows` と同じ。門にはしない——語彙構成の数字は報告に留める（ADR 0148）。 */
  channels?: readonly RecallChannel[];
}

export interface RetrievalQualityCassetteJson {
  recordedAt: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
  };
}

export interface RetrievalQualityRunJson {
  schemaVersion: 1;
  measuredAt: string;
  commit: string | null;
  providerSource: "recorded" | "openai";
  cassette: RetrievalQualityCassetteJson | null;
  probeCount: number;
  /** `ingest.observationCount` から probe 分を引いて求める。`DEFAULT_HAYSTACK_SIZE` を書き写すと、呼び出し側が別の値を渡したときにこの JSON だけ古い値のまま残る。 */
  haystackSize: number;
  arms: RetrievalQualityArmJson[];
}

export interface BuildRetrievalQualityJsonOptions {
  reports: readonly ArmReport[];
  providerSource: "recorded" | "openai";
  cassette: Cassette | undefined;
  measuredAt: Date;
  commit: string | null;
}

/**
 * 純関数。`measuredAt`/`commit` は呼び出し側が渡す。`reports` が空でも例外にしない: `probeCount`/`haystackSize` が 0 になることで
 * 「今回は arm が無かった」を表す。
 */
export function buildRetrievalQualityJson(
  options: BuildRetrievalQualityJsonOptions,
): RetrievalQualityRunJson {
  const first = options.reports[0];
  const probeCount = first?.probes.length ?? 0;
  const haystackSize = first ? first.ingest.observationCount - probeCount * 2 : 0;

  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    providerSource: options.providerSource,
    cassette: options.cassette
      ? {
          recordedAt: options.cassette.recordedAt,
          embedding: {
            provider: options.cassette.embedding.space.provider,
            model: options.cassette.embedding.space.model,
            dimensions: options.cassette.embedding.space.dimensions,
          },
        }
      : null,
    probeCount,
    haystackSize,
    arms: options.reports.map((report) => {
      const headline = armHeadline(report);
      return {
        armLabel: report.armLabel,
        llmMode: report.llmMode,
        embeddingMode: report.embeddingMode,
        mrrOverall: headline.mrrOverall,
        mrrLexicalControl: report.mrrLexicalControl,
        mrrNonLexical: report.mrrNonLexical,
        hit1Count: headline.hit1Count,
        hit10Count: headline.hit10Count,
        probeCount: headline.probeCount,
        lexicalMatchRows: headline.lexicalMatchRows,
        recalledRows: headline.recalledRows,
        termDistinct: headline.termDistinct,
        decayFreshnessEqualRows: headline.decayFreshnessEqualRows,
        decayFreshnessDifferentRows: headline.decayFreshnessDifferentRows,
        channels: report.channels,
      };
    }),
  };
}
