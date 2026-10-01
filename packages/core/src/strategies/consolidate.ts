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
 * `attributes` の積集合（ADR 0312 決定4）: `eligible` **全件**に同じキー・同じ値で
 * 入っているものだけを残す。1件でも欠けている・値が違うキーは落ちる。
 *
 * `buildConsolidatedMemory`（下）と `buildReflectedMemory`（`reflect.ts`）が共有する
 * 純関数——統合・反芻はどちらも「Observation に由来しない、複数の既存 Memory から
 * 新しい Memory を組み立てる」という同じ形の操作であり（`buildReflectedMemory` の
 * doc コメントが `buildConsolidatedMemory` の「双子」と呼ぶ関係）、`attributes` の
 * 引き継ぎ方もこの2つの経路で意図的に揃える——本 PR（Issue #152/#153、ADR 0312）の
 * 判断。理由: `attributes` は内容ではなく取り扱い（公開範囲など）を表す軸であり、
 * 統合・反芻のどちらも「元の記憶の集合から新しい記憶を作る」という点で対称だから
 * である（迷ったときは積集合＝落とす方向へ倒す、ADR 0312 決定4）。
 *
 * `eligible` が空なら `{}`（呼び出し側は必ず1件以上を渡す契約だが、空配列に対しても
 * 安全に `{}` を返す）。
 */
export function intersectAttributes(
  eligible: ReadonlyArray<Pick<Memory, "attributes">>,
): Attributes {
  if (eligible.length === 0) {
    return {};
  }
  const [first, ...rest] = eligible;
  // ADR 0472: `result[key] = value` は key が `__proto__` のとき黙って捨てられる（キーの文字種の検査
  // `ATTRIBUTE_KEY_PATTERN` は `__proto__` を通す）。`Object.fromEntries` は自前のキーとして作る。
  const entries = Object.entries(first!.attributes ?? {}).filter(([key, value]) =>
    rest.every((m) => (m.attributes ?? {})[key] === value),
  );
  return Object.fromEntries(entries);
}

/**
 * `runtime.consolidate`（Issue #103、ADR 0089）が LLM に返させる構造化スキーマ。
 *
 * `extraction.ts` の `ExtractionResultSchema`（`{ memories: [...] }`）とは**別のスキーマ**
 * である——抽出は「1件の Observation → 0〜N件の Memory 候補」だが、統合は
 * 「N件の Memory → ちょうど1件の統合結果」であり、配列に包まない。
 */
export const ConsolidationLLMResultSchema = z.object({
  content: z.string().min(1),
  /**
   * 省略・空文字は「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
   * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
/** {@link ConsolidationLLMResultSchema} の型（統合の LLM が返す値）。 */
export type ConsolidationLLMResult = z.infer<typeof ConsolidationLLMResultSchema>;

/**
 * `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約は
 * {@link ConsolidationLLMResultSchema} 側にある。
 *
 * ⚠ **件数の上限も切り詰めも無い**（今の振る舞い）。統合する記憶の `content` と `digest` を全部、そのまま
 * 並べる。`{ memoryIds }` の形は件数に上限が無いので、プロンプトは対象の本文の合計にほぼ比例して
 * 大きくなる（2026-09-27 の実測: 1000件×約1000字で約3.0MB。`@mnemora/anthropic` と
 * `@mnemora/openai` で同じ）。`{ query }`/`{ seedMemoryId }` の形は `recall()` の `limit` と
 * `maxCandidates` で件数が抑えられる。入力がモデルの上限を超えると、provider は API の拒否を
 * そのまま投げ、`outcome: "llm_failed"`（`llmFailure.kind: null`）になる——書き込みは0件である。
 *
 * Issue #1370: 統合結果の言語を、渡された記憶と同じ言語で書くよう明示する（無条件・
 * 録音済みカセットには使われていない文面——`buildExtractionPrompt` の
 * `subjectCandidates` 分岐と違い、`buildConsolidationPrompt` は録音のキーに縛られない）。
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
   * 統合される側（`status: 'active'` の eligible）。**入力の順序をそのまま使う**——
   * `occurredAt` の最新判定・`subjectId` の一致判定・タグの和集合はこの並びに従う。
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
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3・5:
   * `extraction.ts` の `BuildNewMemoryParams.activitySeq`/`halfLifeRecalls` と同じ形
   * ——両方揃っているときだけ活動時計の3つ組を作る。`'wall'` のテナントでは
   * 呼び出し側がどちらも渡さない。
   */
  activitySeq?: number | undefined;
  /** 活動時計のテナントの半減期（`recall()` の回数）。`activitySeq` と揃って渡したときだけ効く。 */
  halfLifeRecalls?: number | undefined;
}

/**
 * 統合先の `NewMemory` を組み立てる純関数（Issue #103 §手順6、ADR 0089）。
 *
 * ⚠ **`extraction.ts` の `buildNewMemoryFromCandidate` は流用できない**——あちらは
 * Observation 由来の Memory を組み立てる前提（`sourceObservationId`/`extractorVersion`/
 * `provenance.kind: 'stated' | 'inferred'` を Observation から導く）であり、統合はどの
 * Observation にも由来しない。この関数はそのための専用の純関数である。
 *
 * - `subjectId`: eligible 全件の `subjectId` が一致すればその値、割れていれば `null`。
 * - `provenance`: `{ kind: 'consolidated', sources: <eligible の memoryId> }`。
 * - `tags`: LLM が返した `tags` があればそれを使い、無ければ eligible の `tags` の和集合。
 * - `attributes`: eligible 全件の積集合（`intersectAttributes`、ADR 0312 決定4）。
 * - `occurredAt`: eligible の `occurredAt` のうち最も新しいもの。全部 `null` なら `null`。
 * - `validFrom` / `validUntil`: eligible 全件の**区間の積**（`intersectValidity`、`validity.ts`。
 *   Issue #1188 残り、ADR 0368）——`validFrom` は最大値、`validUntil` は最小値。全部
 *   `null` なら両方 `null`（今までの振る舞いのまま）。
 * - `sourceObservationId` / `extractorVersion`: 常に `null`（Observation 由来ではない）。
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

  // ADR 0165 決めたこと3・5: 活動時計の3つ組（`extraction.ts` の
  // `buildNewMemoryFromCandidate` と同じ規律）。
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
    provenance: { kind: "consolidated", sources: eligible.map((m) => m.id) },
    tags,
    // Issue #153（ADR 0312 決定4）: 積集合。`intersectAttributes`（上）参照。
    attributes: intersectAttributes(eligible),
    occurredAt,
    // Issue #1188 残り（ADR 0368）: 区間の積。`intersectValidity`（`validity.ts`）参照。
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
 * `{ seedMemoryId }` 形（Issue #135、ADR 0152）が使う「似ている」の物差し。
 *
 * **新しく発明しない。**`recall()` が既に使っている物差しをそのまま流用する
 * （`strategies/scoring.ts` の `affinity = max(similarity, lexicalMatch)`、ADR 0084 §5）。
 * `consolidate` が別の「似ている」を持つと、recall が近いと言うものと consolidate が
 * 近いと言うものが食い違う——同じ製品の中に「似ている」の定義が2つ立つことになる。
 *
 * `RecalledMemory.score` は候補がどの段を通って見つかったかによって `similarity`/
 * `lexicalMatch` のどちらか・両方・どちらも無し、の3通りがある
 * （`mandatory_companion` 経由は両方とも無い——矛盾の相手として同伴取得されただけで、
 * クエリへの近さを測っていない）。**どちらも無い候補には -Infinity を渡し、
 * どんな `minAffinity`（有限値である限り）でも必ず落ちるようにする**——
 * 「似ているかどうか分からない」を「似ている」側へ倒さない。
 *
 * `similarity` が `NaN`（測れなかった）のときは、無いものとして扱う（`lexicalMatch` があればそれを使う）。
 * 以前は `Math.max` が `NaN` をそのまま返し、`lexicalMatch` の値が捨てられていた。
 *
 * **2026-09-29 追記（Issue #548 方向2、[ADR 0352](../../../../docs/decisions/0352-association-score-without-total.md)）:**
 * `RecalledMemory.score` の型が `ScoreBreakdown | AffinityUnmeasuredScore` になった後も、
 * この関数の値は1バイトも変わらない——`affinityMeasured === false`（`AffinityUnmeasuredScore`。
 * `similarity`/`lexicalMatch` を欄として持たない）は、上の「どちらも無い候補」と同じ
 * 集合そのものである（`mandatory_companion`・`association` はどちらも
 * `defaultScoringStrategy` に `similarity`/`lexicalMatch` を渡さないため常に
 * `affinityMeasured: false` になる）。⟹ 型で先に判別できるようになった分、
 * `score.similarity`/`score.lexicalMatch` を読む前に早期 return するだけで、
 * 返す値（-Infinity）は以前と同じである。
 */
export function computeAffinity(score: RecalledScore): number {
  if (score.affinityMeasured === false) return -Infinity;
  const similarity =
    score.similarity === undefined || Number.isNaN(score.similarity) ? -Infinity : score.similarity;
  return Math.max(similarity, score.lexicalMatch ?? -Infinity);
}
