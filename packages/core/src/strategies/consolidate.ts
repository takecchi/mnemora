import { z } from "zod";
import type { Attributes } from "../attributes.js";
import type { Ctx } from "../ctx.js";
import { resolveDigest } from "../extraction.js";
import { intersectValidity } from "../validity.js";
import { dropBlankTags } from "../llm-tags.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecalledScore } from "../recall.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "./decay.js";
import { resolveCommonSubjectId } from "../memory-subject.js";

/**
 * `attributes` の積集合（ADR 0312）: `eligible` **全件**に同じキー・同じ値で入っているものだけを残す。
 * 1件でも欠けている・値が違うキーは落ちる（迷ったときは落とす方向へ倒す）。
 *
 * `buildConsolidatedMemory` と `buildReflectedMemory`（`reflect.ts`）が共有する純関数で、統合・反芻の
 * どちらも「複数の既存 Memory から新しい Memory を組み立てる」対称な操作なので、引き継ぎ方を揃える。
 * `eligible` が空でも `{}` を返す。
 */
export function intersectAttributes(
  eligible: ReadonlyArray<Pick<Memory, "attributes">>,
): Attributes {
  if (eligible.length === 0) {
    return {};
  }
  const [first, ...rest] = eligible;
  // `result[key] = value` は key が `__proto__` のとき黙って捨てられる。`Object.fromEntries` は自前のキーとして作る（ADR 0472）。
  const entries = Object.entries(first!.attributes ?? {}).filter(([key, value]) =>
    rest.every((m) => (m.attributes ?? {})[key] === value),
  );
  return Object.fromEntries(entries);
}

/**
 * `runtime.consolidate`（ADR 0089）が LLM に返させる構造化スキーマ。
 *
 * 抽出の `ExtractionResultSchema`（`{ memories: [...] }`）とは**別のスキーマ**で、統合は
 * 「N件の Memory → ちょうど1件」なので配列に包まない。
 */
export const ConsolidationLLMResultSchema = z.object({
  content: z.string().min(1),
  /**
   * 省略・空文字・空白だけは「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
   * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
/** {@link ConsolidationLLMResultSchema} の型（統合の LLM が返す値）。 */
export type ConsolidationLLMResult = z.infer<typeof ConsolidationLLMResultSchema>;

/**
 * `completeStructured` へ渡すプロンプト。契約は {@link ConsolidationLLMResultSchema} 側にある。
 *
 * ⚠ **件数の上限も切り詰めも無い。**統合する記憶の `content` と `digest` を全部そのまま並べる。
 * `{ memoryIds }` の形は件数に上限が無いので、プロンプトは対象の本文の合計にほぼ比例して大きくなる
 * （1000件×約1000字で約3.0MB）。`{ query }`/`{ seedMemoryId }` の形は `recall()` の `limit` と
 * `maxCandidates` で件数が抑えられる。入力がモデルの上限を超えると、provider は API の拒否をそのまま投げ、
 * `outcome: "llm_failed"`（`llmFailure.kind: null`）になる（書き込みは0件）。
 *
 * 統合結果の言語は、渡された記憶と同じ言語で書くよう無条件に明示する。
 */
export function buildConsolidationPrompt(eligible: Memory[]): PromptSpec {
  return {
    system:
      "あなたは複数の記憶を1件に統合するアシスタントです。渡された記憶それぞれの本文と要旨を読み、" +
      "重複を除いて1つの本文にまとめてください。矛盾する内容がある場合はどちらも書き残してください。" +
      "統合した本文と要旨は、渡された記憶と同じ言語で書いてください。",
    messages: [
      {
        role: "user",
        content: eligible
          .map((m, i) => `[${i + 1}] content: ${m.content}\ndigest: ${m.digest}`)
          .join("\n\n"),
      },
    ],
  };
}

/** `buildConsolidatedMemory`（統合先の `NewMemory` を組み立てる純関数）の入力。 */
export interface BuildConsolidatedMemoryParams {
  /** `tenantId` を統合先に使う。`subjectId` は `eligible` から決める（全件で同じならその値、違えば `null`）。 */
  ctx: Ctx;
  /**
   * 統合される側（`status: 'active'` の eligible）。**入力の順序をそのまま使う**。
   * タグの和集合の並びと `provenance.sources` の並びはこの並びに従う。
   */
  eligible: Memory[];
  /** 統合の LLM が返した値（本文・digest・tags）。 */
  llmResult: ConsolidationLLMResult;
  /** 本文から `contentHash` を作る関数（`RuntimeDeps.hashContent` と同じもの）。 */
  hashContent: (content: string) => string;
  /** LLM の digest が無い・空のときに、本文の先頭から切り出す長さ。 */
  digestFallbackLength: number;
  /** 統合先の半減期（時間）。 */
  halfLifeHours: number;
  /** 統合先の `recordedAt` にする時刻（減衰の起点にもなる）。 */
  now: Date;
  /**
   * `extraction.ts` の `BuildNewMemoryParams.activitySeq`/`halfLifeRecalls` と同じ形で、両方揃っているときだけ
   * 活動時計の3つ組を作る（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md)）。`'wall'` のテナントでは
   * 呼び出し側がどちらも渡さない。
   */
  activitySeq?: number | undefined;
  /** 活動時計のテナントの半減期（`recall()` の回数）。`activitySeq` と揃って渡したときだけ効く。 */
  halfLifeRecalls?: number | undefined;
}

/**
 * 統合先の `NewMemory` を組み立てる純関数（ADR 0089）。
 *
 * `extraction.ts` の `buildNewMemoryFromCandidate` は流用できない。あちらは Observation 由来の Memory
 * （`sourceObservationId`/`extractorVersion`/`provenance.kind` を Observation から導く）が前提で、統合は
 * どの Observation にも由来しない。
 *
 * - `subjectId`: eligible 全件の `subjectId` が一致すればその値、割れていれば `null`。
 * - `provenance`: `{ kind: 'consolidated', sources: <eligible の memoryId> }`。
 * - `tags`: LLM が返した `tags` があればそれ（空文字・空白だけの要素は `dropBlankTags` で捨てる）、
 *   無ければ eligible の `tags` の和集合（重複は除く）。
 * - `attributes`: eligible 全件の積集合（`intersectAttributes`）。
 * - `occurredAt`: eligible の `occurredAt` のうち最も新しいもの。全部 `null` なら `null`。
 * - `validFrom` / `validUntil`: eligible 全件の区間の積（`intersectValidity`、ADR 0368）。
 * - `sourceObservationId` / `extractorVersion`: 常に `null`。
 */
export function buildConsolidatedMemory(params: BuildConsolidatedMemoryParams): NewMemory {
  const { eligible, llmResult, now } = params;

  const subjectId = resolveCommonSubjectId(eligible);

  const { digest, digestSource } = resolveDigest(
    { content: llmResult.content, digest: llmResult.digest },
    params.digestFallbackLength,
  );

  const tagUnion = Array.from(new Set(eligible.flatMap((m) => m.tags)));
  const tags = llmResult.tags !== undefined ? dropBlankTags(llmResult.tags) : tagUnion;

  const occurredAtCandidates = eligible
    .map((m) => m.occurredAt ?? null)
    .filter((d): d is Date => d !== null);
  const occurredAt =
    occurredAtCandidates.length === 0
      ? null
      : new Date(Math.max(...occurredAtCandidates.map((d) => d.getTime())));

  const decayFloorAt = defaultDecayStrategy.floorAt({
    recordedAt: now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
  });

  // 活動時計の3つ組（`extraction.ts` の `buildNewMemoryFromCandidate` と同じ規律）。
  const hasActivityInputs =
    params.activitySeq !== undefined && params.halfLifeRecalls !== undefined;
  const decayBaseSeq = hasActivityInputs ? params.activitySeq : undefined;
  const decayFloorSeq = hasActivityInputs
    ? defaultActivityDecayStrategy.floorAt({
        baseSeq: params.activitySeq!,
        strength: 1,
        halfLifeRecalls: params.halfLifeRecalls!,
      })
    : undefined;

  return {
    tenantId: params.ctx.tenantId,
    subjectId,
    sourceObservationId: eligible[0]?.sourceObservationId ?? null,
    extractorVersion: null,
    content: llmResult.content,
    contentHash: params.hashContent(llmResult.content),
    digest,
    digestSource,
    provenance: { kind: "consolidated", sources: eligible.map((m) => m.id) },
    tags,
    attributes: intersectAttributes(eligible),
    occurredAt,
    ...intersectValidity(eligible),
    recordedAt: now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
    decayFloorAt,
    decayBaseSeq,
    decayFloorSeq,
    halfLifeRecalls: hasActivityInputs ? params.halfLifeRecalls : undefined,
    embeddingStatus: "pending",
  };
}

/**
 * `{ seedMemoryId }` 形（ADR 0152）が使う「似ている」の物差し。
 *
 * **新しく発明しない。**`recall()` が使っている物差し（`strategies/scoring.ts` の
 * `affinity = max(similarity, lexicalMatch)`）をそのまま流用する。別の「似ている」を持つと、recall が
 * 近いと言うものと consolidate が近いと言うものが食い違う。
 *
 * `affinityMeasured === false`（`mandatory_companion`・`association` 経由。クエリへの近さを測っていない）の
 * 候補には -Infinity を返し、有限の `minAffinity` では必ず落ちるようにする。「似ているかどうか分からない」を
 * 「似ている」側へ倒さない。
 *
 * `similarity` が `NaN`（測れなかった）のときは、無いものとして扱う（`lexicalMatch` があればそれを使う）。
 */
export function computeAffinity(score: RecalledScore): number {
  if (score.affinityMeasured === false) return -Infinity;
  const similarity =
    score.similarity === undefined || Number.isNaN(score.similarity) ? -Infinity : score.similarity;
  return Math.max(similarity, score.lexicalMatch ?? -Infinity);
}
