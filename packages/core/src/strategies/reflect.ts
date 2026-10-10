import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { intersectValidity } from "../validity.js";
import { intersectAttributes } from "./consolidate.js";
import { resolveDigest } from "../extraction.js";
import { dropBlankTags } from "../llm-tags.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "./decay.js";
import { resolveCommonSubjectId } from "../memory-subject.js";

/**
 * `runtime.reflect` が LLM に返させる構造化スキーマ。
 *
 * `ConsolidationLLMResultSchema` と違い、**判別子 `outcome` を持つ**。`consolidate` は必ず1件の結果を返す前提
 * だが、`reflect` は「一般化できるものが実際にあるか」自体を LLM に判定させる必要がある。断れないスキーマを
 * 渡すと、モデルは毎回何かを捏造する。そこで `outcome: 'reflected' | 'nothing'` の判別可能ユニオンにして、
 * 「一般化するものは無い」と答えられる形にした。
 *
 * この必須の判別子 `outcome` は、`ConsolidationLLMResultSchema` とも `ExtractionResultSchema` とも**互いに素**で、
 * 3つのどれを `DeterministicLLMProvider`（`packages/testkit`）に渡しても取り違えて成功することがない。
 */
export const ReflectionLLMResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("reflected"),
    content: z.string().min(1),
    /**
     * 省略・空文字・空白だけは「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
     * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
     */
    digest: z.string().optional(),
    /** 空文字・空白だけの要素は `buildReflectedMemory` が `dropBlankTags` で落とす（抽出・consolidate と同じ）。 */
    tags: z.array(z.string()).optional(),
  }),
  z.object({ outcome: z.literal("nothing") }),
]);
/** {@link ReflectionLLMResultSchema} の型（内省の LLM が返す値。`outcome: "nothing"` を含む）。 */
export type ReflectionLLMResult = z.infer<typeof ReflectionLLMResultSchema>;

/** {@link ReflectionLLMResultSchema} の `outcome: 'reflected'` 側だけを取り出した形。 */
export type ReflectedLLMResult = Extract<ReflectionLLMResult, { outcome: "reflected" }>;

/**
 * `completeStructured` へ渡すプロンプト。契約は {@link ReflectionLLMResultSchema} 側にある。
 *
 * `buildConsolidationPrompt` と違い、**モデルに「無理に一般化を作らないでよい」ことを明示する**。
 * スキーマ側で断れるようにしただけでは、文面が「必ず1件作れ」と読める場合モデルは断らない。
 *
 * ⚠ **件数の上限も切り詰めも無い。**土台にする記憶の `content` と `digest` を全部そのまま並べる。
 * `{ memoryIds }` の形は件数に上限が無いので、プロンプトは対象の本文の合計にほぼ比例して大きくなる
 * （1000件×約1000字で約3.0MB）。`{ query }`/`{ seedMemoryId }` の形は `recall()` の `limit` と
 * `maxCandidates` で件数が抑えられる。入力がモデルの上限を超えると、provider は API の拒否をそのまま投げ、
 * `outcome: "llm_failed"`（`llmFailure.kind: null`）になる（書き込みは0件）。
 *
 * 新しい記憶の言語は、渡された記憶と同じ言語で書くよう無条件に明示する。
 */
export function buildReflectionPrompt(basis: Memory[]): PromptSpec {
  return {
    system:
      "あなたは複数の記憶から、まだ言語化されていない一般化や気づきを見つけるアシスタントです。" +
      "渡された記憶それぞれの本文と要旨を読み、それらに共通するパターンや示唆が実際にある場合" +
      "だけ、それを1件の新しい記憶としてまとめてください。共通点が見つからない、または単なる" +
      "言い換えにしかならない場合は、無理に作らず outcome: 'nothing' を返してください。" +
      "新しい記憶の本文と要旨は、渡された記憶と同じ言語で書いてください。",
    messages: [
      {
        role: "user",
        content: basis
          .map((m, i) => `[${i + 1}] content: ${m.content}\ndigest: ${m.digest}`)
          .join("\n\n"),
      },
    ],
  };
}

/** `buildReflectedMemory`（内省の結果の `NewMemory` を組み立てる純関数）の入力。 */
export interface BuildReflectedMemoryParams {
  /** `tenantId` を内省の結果に使う。`subjectId` は `eligible` から決める（全件で同じならその値、違えば `null`）。 */
  ctx: Ctx;
  /**
   * 土台になった側（`status: 'active'` かつ `provenance.kind !== 'reflected'` の eligible）。
   * **入力の順序をそのまま使う**。タグの和集合の並びと `provenance.sources` の並びはこの並びに従う。
   */
  eligible: Memory[];
  /** 内省の LLM が返した値のうち、記憶を作る側（`outcome: "nothing"` ではないもの）。 */
  llmResult: ReflectedLLMResult;
  /** 本文から `contentHash` を作る関数（`RuntimeDeps.hashContent` と同じもの）。 */
  hashContent: (content: string) => string;
  /** LLM の digest が無い・空のときに、本文の先頭から切り出す長さ。 */
  digestFallbackLength: number;
  /** 内省の結果の半減期（時間）。 */
  halfLifeHours: number;
  /** 内省の結果の `recordedAt` にする時刻（減衰の起点にもなる）。 */
  now: Date;
  /**
   * `extraction.ts` の `BuildNewMemoryParams.activitySeq`/`halfLifeRecalls`・`consolidate.ts` の
   * `BuildConsolidatedMemoryParams` と同じ形（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md)）。
   */
  activitySeq?: number | undefined;
  /** 活動時計のテナントの半減期（`recall()` の回数）。`activitySeq` と揃って渡したときだけ効く。 */
  halfLifeRecalls?: number | undefined;
}

/**
 * 内省の結果の `NewMemory` を組み立てる純関数。
 *
 * `buildConsolidatedMemory` の双子で、`subjectId` の割れ方・`digest` のフォールバック・`tags`・`occurredAt`・
 * `halfLifeHours`・`decayFloorAt`・`embeddingStatus`・`sourceObservationId`/`extractorVersion` の扱いは
 * そのまま踏襲する（どちらも Observation に由来しない、複数の既存 Memory から新しい Memory を組み立てる操作）。
 *
 * - `tags`: LLM が `tags` の欄を返せばそれ（空文字・空白だけの要素は `dropBlankTags` で捨てる。
 *   `[]` や、捨てて空になったときも `[]` のままで、和集合へ倒さない）、
 *   欄が無ければ eligible の `tags` の和集合（重複は除く）。
 * - `attributes`: eligible 全件の積集合（`intersectAttributes`、ADR 0312）。
 * - `validFrom` / `validUntil`: eligible 全件の区間の積（`intersectValidity`、ADR 0368）。`consolidate` と違い、
 *   `reflect` は材料を `superseded` にしないので、材料が期限切れになっても材料自身の行は `active` で残る
 *   （ADR 0368 の代償は `consolidate` 側だけ）。
 * - `halfLifeHours`: 呼び出し側がテナント既定値から決めて渡す。`decayFloorAt` はこの関数が `strength: 1` 前提で計算する。
 * - `strength`: **`1`（`MAX_STRENGTH`）に固定する。**`strength` を下げると、`provenance.kind` が既に表している
 *   「推論か事実か」の区別を2本目の信号で複製することになる。ADR 0078 も初期値の `strength` を設定する口を閉じている。
 * - `provenance`: `{ kind: 'reflected', sources: <eligible の memoryId> }`。`ReflectedProvenance.sources` は型としては
 *   省略可のまま（公開型の破壊的変更を避けるため）だが、この実装が作る値は常に埋める。
 */
export function buildReflectedMemory(params: BuildReflectedMemoryParams): NewMemory {
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

  // 活動時計の3つ組（`extraction.ts`/`consolidate.ts` と同じ規律）。
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
    sourceObservationId: null,
    extractorVersion: null,
    content: llmResult.content,
    contentHash: params.hashContent(llmResult.content),
    digest,
    digestSource,
    provenance: { kind: "reflected", sources: eligible.map((m) => m.id) },
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
