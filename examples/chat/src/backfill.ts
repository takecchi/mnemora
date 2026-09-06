import type { Ctx, RecallResult, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";

/**
 * `observe()` の `occurredAt` を「動く例」で見せるデモ（examples/chat/README.md
 * 「`backfill`」節、ADR 0037）。
 *
 * **なぜ在るか**: `ObserveInput.occurredAt` という口は3つの入力すべてに最初から在り、
 * `runtime.observe` は素通しし、`buildNewMemoryFromCandidate` が `Memory.occurredAt` へ
 * 写す。**しかしリポジトリ内でこの口に値を渡している箇所は0件だった。**
 *
 * `recall-runtime.ts` は `effectiveTime = memory.occurredAt ?? memory.recordedAt` で
 * `occurredAfter` / `occurredBefore` を当てる。⟹ **`occurredAt` を渡さないと、
 * 「いつの出来事か」を絞ると読める欄が、実際には「いつ言われたか」を絞る。**
 * 生の会話ログを後から取り込む（backfill）と `recordedAt` は今日になるので、
 * **同じ問い合わせが黙って別の答えを返す。**このデモはその差を並べて見せる。
 *
 * **⚠ 北極星の主測定（`compare` / `retrieval`）には一切関わらない。**このファイルは
 * `runComparison` / `runRetrievalQualityArm` を呼ばず、`compare.ts` / `retrieval-quality.ts` /
 * `probe-set.ts` / `scenario.ts` / `naive-path.ts` のいずれも import しない
 * （`scope.ts` と同じ規律）。
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * 「古い」出来事を何日前に置くか。
 *
 * ⚠ 既定の半減期（720時間 = 30日）に対して**わざと小さく**取ってある。例えば365日前に
 * すると `freshness` が 0.000217 まで落ち、既定の `scoreThreshold`（0.1）で落ちてしまう
 * ——**period で落ちたのか閾値で落ちたのかが、画面から区別できなくなる。**
 */
export const BACKFILL_OLD_DAYS = 20;
export const BACKFILL_RECENT_DAYS = 2;
/** `recall({ occurredAfter })` の境目。古いほうだけが外に出る位置に置く。 */
export const BACKFILL_CUTOFF_DAYS = 10;

/**
 * 2つの発話。**長さを揃えてある**——擬似 embedding は文字コードから機械的にベクトルを
 * 作るので、長さが近いほど類似度の差が小さくなる。**⟹ 返るか落ちるかの差が
 * period フィルタ由来であることを、画面上で読み取りやすくする。**
 */
export const BACKFILL_OLD_FACT = "三週間前に沖縄へ旅行しました。";
export const BACKFILL_RECENT_FACT = "一昨日に金沢へ旅行しました。";
export const BACKFILL_QUERY = "わたしの旅行について知っていますか?";

const OLD_EXTERNAL_ID = "backfill-demo-old";
const RECENT_EXTERNAL_ID = "backfill-demo-recent";

export interface BackfillDemoResult {
  /** `occurredAt` を渡して取り込んだテナント。 */
  withOccurredAtTenantId: string;
  /** `occurredAt` を渡さずに取り込んだテナント（いままでの呼び方）。 */
  withoutOccurredAtTenantId: string;
  cutoff: Date;
  /** `occurredAt` を渡した側に `occurredAfter` を掛けた結果。 */
  withOccurredAt: RecallResult;
  /** `occurredAt` を渡さなかった側に、**同じ** `occurredAfter` を掛けた結果。 */
  withoutOccurredAt: RecallResult;
}

function includesDigest(memories: { digest: string }[], marker: string): boolean {
  return memories.some((m) => m.digest.includes(marker));
}

function hasPeriodOmission(result: RecallResult): boolean {
  return result.omitted.some((o) => o.kind === "filtered" && o.condition === "period");
}

export interface BackfillDemoCheck {
  /** `occurredAt` あり: 古い出来事が落ちたか。 */
  withOccurredAtDropsOld: boolean;
  /** `occurredAt` あり: 新しい出来事は残ったか。 */
  withOccurredAtKeepsRecent: boolean;
  /** `occurredAt` あり: 落ちた理由が `filtered: period` として出ているか。 */
  withOccurredAtReportsPeriod: boolean;
  /** ⚠ `occurredAt` なし: 古い出来事も**残ってしまう**か（残るなら true ＝ 絞りが効いていない）。 */
  withoutOccurredAtKeepsOld: boolean;
  /** ⚠ `occurredAt` なし: `filtered: period` が1件も出ないか。 */
  withoutOccurredAtReportsNothing: boolean;
}

/** `BackfillDemoResult` から、見せたい性質を機械的に判定する（印字・歯の両方が使う）。 */
export function checkBackfillDemo(result: BackfillDemoResult): BackfillDemoCheck {
  return {
    withOccurredAtDropsOld: !includesDigest(result.withOccurredAt.memories, "沖縄"),
    withOccurredAtKeepsRecent: includesDigest(result.withOccurredAt.memories, "金沢"),
    withOccurredAtReportsPeriod: hasPeriodOmission(result.withOccurredAt),
    withoutOccurredAtKeepsOld: includesDigest(result.withoutOccurredAt.memories, "沖縄"),
    withoutOccurredAtReportsNothing: !hasPeriodOmission(result.withoutOccurredAt),
  };
}

/**
 * 同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせる。
 *
 * **テナントを分けるのは、`externalId` の冪等性が同じテナント内で効くため**——
 * 同じテナントに同じ `externalId` で2度 observe すると、2回目は既存の Observation を
 * 返してしまい、`occurredAt` の有無を比べられない。
 */
export async function runBackfillDemo(
  runtime: Runtime,
  tenantIds: { withOccurredAt: string; withoutOccurredAt: string },
  now: Date = new Date(),
): Promise<BackfillDemoResult> {
  const withCtx: Ctx = { tenantId: tenantIds.withOccurredAt };
  const withoutCtx: Ctx = { tenantId: tenantIds.withoutOccurredAt };
  const oldOccurredAt = new Date(now.getTime() - BACKFILL_OLD_DAYS * DAY);
  const recentOccurredAt = new Date(now.getTime() - BACKFILL_RECENT_DAYS * DAY);
  const cutoff = new Date(now.getTime() - BACKFILL_CUTOFF_DAYS * DAY);

  // 1. 出来事の時刻を渡して取り込む（backfill の正しい呼び方）。
  await runtime.observe(withCtx, {
    kind: "utterance",
    text: BACKFILL_OLD_FACT,
    speaker: "user",
    externalId: OLD_EXTERNAL_ID,
    occurredAt: oldOccurredAt,
  });
  await runtime.observe(withCtx, {
    kind: "utterance",
    text: BACKFILL_RECENT_FACT,
    speaker: "user",
    externalId: RECENT_EXTERNAL_ID,
    occurredAt: recentOccurredAt,
  });
  await drainEmbedTicks(runtime, withCtx);

  // 2. 渡さずに取り込む（これまでの呼び方。recordedAt は今日になる）。
  await runtime.observe(withoutCtx, {
    kind: "utterance",
    text: BACKFILL_OLD_FACT,
    speaker: "user",
    externalId: OLD_EXTERNAL_ID,
  });
  await runtime.observe(withoutCtx, {
    kind: "utterance",
    text: BACKFILL_RECENT_FACT,
    speaker: "user",
    externalId: RECENT_EXTERNAL_ID,
  });
  await drainEmbedTicks(runtime, withoutCtx);

  const withOccurredAt = await runtime.recall(withCtx, {
    text: BACKFILL_QUERY,
    occurredAfter: cutoff,
  });
  const withoutOccurredAt = await runtime.recall(withoutCtx, {
    text: BACKFILL_QUERY,
    occurredAfter: cutoff,
  });

  return {
    withOccurredAtTenantId: tenantIds.withOccurredAt,
    withoutOccurredAtTenantId: tenantIds.withoutOccurredAt,
    cutoff,
    withOccurredAt,
    withoutOccurredAt,
  };
}

function formatMemoryList(memories: { digest: string }[]): string {
  if (memories.length === 0) {
    return "  (0件)";
  }
  return memories.map((m) => `  - "${m.digest}"`).join("\n");
}

function formatOmitted(result: RecallResult): string {
  if (result.omitted.length === 0) {
    return "  omitted: (無し)";
  }
  return `  omitted: ${result.omitted.map((o) => ("condition" in o ? `${o.kind}:${o.condition}` : o.kind)).join(", ")}`;
}

/** 画面向けの印字。**同じ問い合わせが、取り込み方だけで別の答えを返す**ことを並べて見せる。 */
export function formatBackfillDemo(result: BackfillDemoResult): string {
  const check = checkBackfillDemo(result);
  const lines: string[] = [];

  lines.push(
    `取り込んだ2件: 「${BACKFILL_OLD_FACT}」(${BACKFILL_OLD_DAYS}日前の出来事) / ` +
      `「${BACKFILL_RECENT_FACT}」(${BACKFILL_RECENT_DAYS}日前の出来事)`,
  );
  lines.push(
    `問い合わせ: recall({ text: "${BACKFILL_QUERY}", occurredAfter: ${result.cutoff.toISOString()} })`,
  );
  lines.push(`（＝ ${BACKFILL_CUTOFF_DAYS}日前より後の「出来事」だけを求めている）`);
  lines.push("");

  lines.push(
    `--- 1. observe() に occurredAt を渡した（tenant=${result.withOccurredAtTenantId}）---`,
  );
  lines.push(`件数: ${result.withOccurredAt.memories.length}`);
  lines.push(formatMemoryList(result.withOccurredAt.memories));
  lines.push(formatOmitted(result.withOccurredAt));
  lines.push(
    `⟹ 古い出来事が落ちた: ${check.withOccurredAtDropsOld ? "はい" : "いいえ"} / ` +
      `新しい出来事は残った: ${check.withOccurredAtKeepsRecent ? "はい" : "いいえ"} / ` +
      `理由が period として出た: ${check.withOccurredAtReportsPeriod ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push(`--- 2. ⚠ occurredAt を渡さなかった（tenant=${result.withoutOccurredAtTenantId}）---`);
  lines.push(`件数: ${result.withoutOccurredAt.memories.length}`);
  lines.push(formatMemoryList(result.withoutOccurredAt.memories));
  lines.push(formatOmitted(result.withoutOccurredAt));
  lines.push(
    `⟹ ⚠ 古い出来事も残ってしまう: ${check.withoutOccurredAtKeepsOld ? "はい" : "いいえ"} / ` +
      `period の omission は出ない: ${check.withoutOccurredAtReportsNothing ? "はい" : "いいえ"}`,
  );
  lines.push("");
  lines.push("⟹ **同じ問い合わせが、取り込み方だけで別の答えを返す。**occurredAt を渡さないと、");
  lines.push(
    "   effectiveTime が recordedAt（＝取り込んだ今日）に落ちるので、「いつの出来事か」を",
  );
  lines.push("   絞ったつもりの条件が、実際には「いつ言われたか」を絞っている。");

  return lines.join("\n");
}
