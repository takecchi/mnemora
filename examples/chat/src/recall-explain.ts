import { randomUUID } from "node:crypto";
import type {
  Ctx,
  MemoryStore,
  RecallId,
  RecallRecord,
  RecallRecordMemory,
  RecallRecordReturnedMemories,
  RecalledScore,
  Runtime,
} from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";

/**
 * 「なぜそれを思い出したのかを、後から説明できる」の「後から」を見せるデモ。`recall()` を呼んだその場で整形せず、
 * `recallId` だけを持ち帰り、別の呼び出し `runtime.getRecall(ctx, recallId)` で永続化された行を読み戻す。
 * 測定条件を一切共有しない独立したデモで、`compare`/`retrieval` 側のファイルを import しない。
 * 表示に使う値は `RecallRecord` から作り、プロンプトへ積む文字列には混ぜない。
 */

const EXPLAIN_FACT_FOOD = "好きな食べ物はカレーです。";
const EXPLAIN_FACT_HOBBY = "趣味は写真撮影です。";
/**
 * 意図的に embed させないままにする3件目。`drainEmbedTicks` をこの発話の前までしか呼ばないので `pending` のまま残り、
 * `omitted` に `not_indexed` が現れることを実演する。
 */
const EXPLAIN_FACT_PENDING = "住んでいる街は京都です。";

const EXPLAIN_EXTERNAL_ID_FOOD = "recall-explain-demo-food";
const EXPLAIN_EXTERNAL_ID_HOBBY = "recall-explain-demo-hobby";
const EXPLAIN_EXTERNAL_ID_PENDING = "recall-explain-demo-pending";

export const RECALL_EXPLAIN_QUERY = "好きな食べ物と趣味は何ですか?";

export interface RecallExplainDemoResult {
  tenantId: string;
  recallId: RecallId;
  /** 表示には使わない。`record` と同じ集合かを歯から突き合わせるためだけに持つ。 */
  recallResultMemoryIds: string[];
  /** その場の `RecallResult` を整形し直したものではない——別の呼び出しで、永続化された `recalls` 行を読み戻したもの。 */
  record: RecallRecord | null;
  missingRecallId: RecallId;
  missingRecord: RecallRecord | null;
  /** `RecallRecordMemory` 自身は `digest` を運ばないので、`MemoryStore.get` で個別に引く。 */
  digestByMemoryId: Record<string, string>;
}

export async function runRecallExplainDemo(
  runtime: Runtime,
  memoryStore: MemoryStore,
  tenantId: string,
): Promise<RecallExplainDemoResult> {
  const ctx: Ctx = { tenantId };

  const foodObserved = await runtime.observe(ctx, {
    kind: "utterance",
    text: EXPLAIN_FACT_FOOD,
    speaker: "user",
    externalId: EXPLAIN_EXTERNAL_ID_FOOD,
  });
  const hobbyObserved = await runtime.observe(ctx, {
    kind: "utterance",
    text: EXPLAIN_FACT_HOBBY,
    speaker: "user",
    externalId: EXPLAIN_EXTERNAL_ID_HOBBY,
  });
  // 冪等な再送では `observed.memoryIds` が空になるので、合計を `drainEmbedTicks` に渡す（claim 0件のまま黙って抜けさせない）。
  await drainEmbedTicks(runtime, ctx, {
    expectedProcessed: foodObserved.memoryIds.length + hobbyObserved.memoryIds.length,
  });

  // 3件目はこの後で観測し、embed ジョブを積んだままにする（呼ばないのが意図的）。
  await runtime.observe(ctx, {
    kind: "utterance",
    text: EXPLAIN_FACT_PENDING,
    speaker: "user",
    externalId: EXPLAIN_EXTERNAL_ID_PENDING,
  });

  const recallResult = await runtime.recall(ctx, { text: RECALL_EXPLAIN_QUERY });
  const { recallId } = recallResult;

  // ここから先は上の recallResult を一切参照しない。recallId だけを渡して、別の呼び出しで読み戻す。
  const record = await runtime.getRecall(ctx, recallId);

  const missingRecallId: RecallId = randomUUID();
  const missingRecord = await runtime.getRecall(ctx, missingRecallId);

  const digestByMemoryId: Record<string, string> = {};
  if (record && record.returnedMemories.breakdownCaptured) {
    for (const m of record.returnedMemories.memories) {
      const memory = await memoryStore.get(ctx, m.memoryId);
      if (memory) {
        digestByMemoryId[m.memoryId] = memory.digest;
      }
    }
  }

  return {
    tenantId,
    recallId,
    recallResultMemoryIds: recallResult.memories.map((m) => m.memoryId),
    record,
    missingRecallId,
    missingRecord,
    digestByMemoryId,
  };
}

/** `affinityMeasured: false` は `similarity`/`lexicalMatch`/`total` を持たないので、その3つを省いて表示する（比較可能でない値を作らない）。 */
function formatScoreBreakdown(score: RecalledScore): string {
  const parts: string[] = [];
  if (score.affinityMeasured !== false) {
    if (score.similarity !== undefined) {
      parts.push(`similarity=${score.similarity.toFixed(3)}`);
    }
    if (score.lexicalMatch !== undefined) {
      parts.push(`lexicalMatch=${score.lexicalMatch.toFixed(3)}`);
    }
  }
  parts.push(`decay=${score.decay.toFixed(3)}`);
  parts.push(`tagMatch=${score.tagMatch.toFixed(3)}`);
  parts.push(`freshness=${score.freshness.toFixed(3)}`);
  parts.push(`strength=${score.strength.toFixed(3)}`);
  parts.push(score.affinityMeasured === false ? "total=n/a" : `total=${score.total.toFixed(3)}`);
  return parts.join(" ");
}

function formatReturnedMemory(
  m: RecallRecordMemory | { memoryId: string },
  breakdownCaptured: boolean,
  digestByMemoryId: Record<string, string>,
): string {
  const digest = digestByMemoryId[m.memoryId] ?? "(digest不明——memoryStore.get で引けなかった)";
  if (!breakdownCaptured || !("score" in m)) {
    return `  - memoryId=${m.memoryId} digest="${digest}" (内訳なし)`;
  }
  const extra = [
    m.companionOf ? `companionOf=${m.companionOf}` : undefined,
    m.associationOf ? `associationOf=${m.associationOf}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(" ");
  return (
    `  - memoryId=${m.memoryId} via=${m.retrievedVia} digest="${digest}" ` +
    `score(${formatScoreBreakdown(m.score)})${extra ? ` ${extra}` : ""}`
  );
}

/** `breakdownCaptured: false` を「0」や「空」に読み替えない。マイグレーション以前の行は内訳を一度も持ったことが無いので、名指しで印字する。 */
function formatReturnedMemories(
  returned: RecallRecordReturnedMemories,
  digestByMemoryId: Record<string, string>,
): string[] {
  const lines: string[] = [];
  lines.push(`breakdownCaptured: ${returned.breakdownCaptured}`);
  if (!returned.breakdownCaptured) {
    lines.push(
      "  ⚠ この recall は内訳を持たない(マイグレーション以前に書かれた行)。" +
        "スコアが無いことは「0」でも「空」でもなく、そもそも記録されなかった(ADR 0008)。",
    );
  }
  lines.push(`returnedMemories (${returned.memories.length} 件):`);
  if (returned.memories.length === 0) {
    lines.push("  (0件)");
  }
  for (const m of returned.memories) {
    lines.push(formatReturnedMemory(m, returned.breakdownCaptured, digestByMemoryId));
  }
  return lines;
}

function formatRecallRecordBody(
  record: RecallRecord,
  digestByMemoryId: Record<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`recallId    = ${record.recallId}`);
  lines.push(`tenantId    = ${record.tenantId}`);
  lines.push(`subjectId   = ${record.subjectId ?? "(無し)"}`);
  lines.push(`createdAt   = ${record.createdAt.toISOString()}`);
  lines.push("");
  lines.push(...formatReturnedMemories(record.returnedMemories, digestByMemoryId));
  lines.push("");
  lines.push(`omitted (${record.omitted.length} 件) — なぜ落ちたか:`);
  if (record.omitted.length === 0) {
    lines.push("  (無し)");
  }
  for (const o of record.omitted) {
    lines.push(`  - ${JSON.stringify(o)}`);
  }
  lines.push("");
  lines.push(
    `indexBand: totalInScope=${record.indexBand.totalInScope} ` +
      `(countKind=${record.indexBand.countKind}), groups=${record.indexBand.groups.length}`,
  );
  lines.push(
    `usage: chars=${record.usage.chars} estimatedTokens=${record.usage.estimatedTokens} ` +
      `(counter=${record.usage.counter})`,
  );
  lines.push(`explain.stages (${record.explain.stages.length} 件) — 段トレース:`);
  for (const stage of record.explain.stages) {
    lines.push(
      `  - stage=${stage.stage} executed=${stage.executed}` +
        (stage.detail ? ` detail=${JSON.stringify(stage.detail)}` : ""),
    );
  }
  return lines.join("\n");
}

/** `null`（見つからなかった）を名指しで印字する。空配列や「0件」に潰さない。 */
function formatRecordOrMissing(
  record: RecallRecord | null,
  digestByMemoryId: Record<string, string>,
): string {
  if (record === null) {
    return (
      "見つからなかった(null) — この recallId の recall は存在しないか、別テナントのもの" +
      "である(MemoryStore.get/getObservation と同じ規律。例外にしない)。"
    );
  }
  return formatRecallRecordBody(record, digestByMemoryId);
}

export function formatRecallExplainDemo(result: RecallExplainDemoResult): string {
  const lines: string[] = [];
  lines.push(`tenantId = ${result.tenantId}`);
  lines.push(`recallId = ${result.recallId}`);
  lines.push("");
  lines.push(
    "⚠ 以下は recall() が返した RecallResult をその場で整形したものではない。" +
      "別の呼び出し runtime.getRecall(ctx, recallId) で、永続化された recalls 行を" +
      "読み戻している。",
  );
  lines.push("");
  lines.push("--- runtime.getRecall(ctx, recallId) ---");
  lines.push(formatRecordOrMissing(result.record, result.digestByMemoryId));
  lines.push("");
  lines.push(`--- runtime.getRecall(ctx, <存在しない recallId=${result.missingRecallId}>) ---`);
  lines.push(formatRecordOrMissing(result.missingRecord, {}));
  return lines.join("\n");
}
