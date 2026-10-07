import type { Ctx, RecallResult, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";

/**
 * `observe()` の `occurredAt` を「動く例」で見せるデモ。`occurredAt` を渡さないと、「いつの出来事か」を絞る欄が
 * 実際には「いつ言われたか」を絞り、backfill すると同じ問い合わせが黙って別の答えを返す。
 *
 * 北極星の主測定（`compare` / `retrieval`）には関わらない。`runComparison` / `runRetrievalQualityArm` を呼ばず、
 * `compare.ts` / `retrieval-quality.ts` / `probe-set.ts` / `scenario.ts` / `naive-path.ts` を import しない。
 */

const DAY = 24 * 60 * 60 * 1000;

/** 「古い」出来事を何日前に置くか。既定の半減期に対して、わざと小さく取る。大きいと `freshness` が閾値で落ち、period で落ちたのか区別できなくなる。 */
export const BACKFILL_OLD_DAYS = 20;
export const BACKFILL_RECENT_DAYS = 2;
export const BACKFILL_CUTOFF_DAYS = 10;

/** 2つの発話。長さを揃える。擬似 embedding は長さが近いほど類似度の差が小さくなり、返るか落ちるかの差が period フィルタ由来だと読み取りやすい。 */
export const BACKFILL_OLD_FACT = "三週間前に沖縄へ旅行しました。";
export const BACKFILL_RECENT_FACT = "一昨日に金沢へ旅行しました。";
export const BACKFILL_QUERY = "わたしの旅行について知っていますか?";

const OLD_EXTERNAL_ID = "backfill-demo-old";
const RECENT_EXTERNAL_ID = "backfill-demo-recent";

export interface BackfillDemoResult {
  withOccurredAtTenantId: string;
  withoutOccurredAtTenantId: string;
  cutoff: Date;
  withOccurredAt: RecallResult;
  withoutOccurredAt: RecallResult;
}

function includesDigest(memories: { digest: string }[], marker: string): boolean {
  return memories.some((m) => m.digest.includes(marker));
}

function hasPeriodOmission(result: RecallResult): boolean {
  return result.omitted.some((o) => o.kind === "filtered" && o.condition === "period");
}

export interface BackfillDemoCheck {
  withOccurredAtDropsOld: boolean;
  withOccurredAtKeepsRecent: boolean;
  withOccurredAtReportsPeriod: boolean;
  withoutOccurredAtKeepsOld: boolean;
  withoutOccurredAtReportsNothing: boolean;
}

export function checkBackfillDemo(result: BackfillDemoResult): BackfillDemoCheck {
  return {
    withOccurredAtDropsOld: !includesDigest(result.withOccurredAt.memories, "沖縄"),
    withOccurredAtKeepsRecent: includesDigest(result.withOccurredAt.memories, "金沢"),
    withOccurredAtReportsPeriod: hasPeriodOmission(result.withOccurredAt),
    withoutOccurredAtKeepsOld: includesDigest(result.withoutOccurredAt.memories, "沖縄"),
    withoutOccurredAtReportsNothing: !hasPeriodOmission(result.withoutOccurredAt),
  };
}

/** 同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせる。`externalId` の冪等性はテナント内で効き、同じテナントでは比べられないため。 */
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

  const withOld = await runtime.observe(withCtx, {
    kind: "utterance",
    text: BACKFILL_OLD_FACT,
    speaker: "user",
    externalId: OLD_EXTERNAL_ID,
    occurredAt: oldOccurredAt,
  });
  const withRecent = await runtime.observe(withCtx, {
    kind: "utterance",
    text: BACKFILL_RECENT_FACT,
    speaker: "user",
    externalId: RECENT_EXTERNAL_ID,
    occurredAt: recentOccurredAt,
  });
  await drainEmbedTicks(runtime, withCtx, {
    expectedProcessed: withOld.memoryIds.length + withRecent.memoryIds.length,
  });

  const withoutOld = await runtime.observe(withoutCtx, {
    kind: "utterance",
    text: BACKFILL_OLD_FACT,
    speaker: "user",
    externalId: OLD_EXTERNAL_ID,
  });
  const withoutRecent = await runtime.observe(withoutCtx, {
    kind: "utterance",
    text: BACKFILL_RECENT_FACT,
    speaker: "user",
    externalId: RECENT_EXTERNAL_ID,
  });
  await drainEmbedTicks(runtime, withoutCtx, {
    expectedProcessed: withoutOld.memoryIds.length + withoutRecent.memoryIds.length,
  });

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
