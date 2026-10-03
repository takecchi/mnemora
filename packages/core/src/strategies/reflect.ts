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
 * `runtime.reflect`（Issue #104）が LLM に返させる構造化スキーマ。
 *
 * `consolidate.ts` の `ConsolidationLLMResultSchema`（`{ content, digest?, tags? }`）とは
 * **判別子 `outcome` を持つ点で意図的に違う**。`consolidate` は必ず1件の統合結果を返す前提
 * （eligible が2件以上あることが手順3で保証されている）だが、`reflect` は「渡された記憶から
 * 一般化できるものが実際にあるか」自体を LLM に判定させる必要がある——断れないスキーマを
 * 渡すと、モデルは毎回何かを捏造する。⟹ `outcome: 'reflected' | 'nothing'` の判別可能
 * ユニオンにして、モデルが「一般化するものは無い」と答えられる形にした。
 *
 * 🔴 この `outcome` という必須の判別子は、`ConsolidationLLMResultSchema`
 * （`{content, digest?, tags?}`、判別子を持たない）とも `extraction.ts` の
 * `ExtractionResultSchema`（`{memories:[...]}`）とも**互いに素**である——3つのどれを
 * `DeterministicLLMProvider`（`packages/testkit`）に渡しても取り違えて成功することがない
 * （`reflect.test.ts` で測っている）。
 */
export const ReflectionLLMResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("reflected"),
    content: z.string().min(1),
    /**
     * 省略・空文字・空白だけは「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
     * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
     * ⚠ 2026-09-28 訂正: 以前は `min(1)` を付けていたので、空文字の digest は応答ごと拒まれ、`reflect()` は
     * `llm_failed` になっていた（この doc と食い違っていた）。抽出・consolidate の schema と同じく空文字を受け付ける。
     */
    digest: z.string().optional(),
    /**
     * 空文字・空白だけの要素は `buildReflectedMemory` が `dropBlankTags` で落とす（抽出・consolidate と同じ）。
     * ⚠ 2026-09-28 訂正: 以前は要素に `min(1)` を付けていたので、空文字の tag が1つでもあると応答ごと拒まれていた。
     */
    tags: z.array(z.string()).optional(),
  }),
  z.object({ outcome: z.literal("nothing") }),
]);
/** {@link ReflectionLLMResultSchema} の型（内省の LLM が返す値。`outcome: "nothing"` を含む）。 */
export type ReflectionLLMResult = z.infer<typeof ReflectionLLMResultSchema>;

/** {@link ReflectionLLMResultSchema} の `outcome: 'reflected'` 側だけを取り出した形。 */
export type ReflectedLLMResult = Extract<ReflectionLLMResult, { outcome: "reflected" }>;

/**
 * `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約は
 * {@link ReflectionLLMResultSchema} 側にある。
 *
 * `buildConsolidationPrompt` と違い、**モデルに「無理に一般化を作らないでよい」ことを
 * 明示する**——スキーマ側で断れるようにしただけでは、文面が「必ず1件作れ」と読める場合
 * モデルは断らない（北極星の問い6「知らないことを知らないと言えるか」の、プロンプト面での
 * 適用）。
 *
 * ⚠ **件数の上限も切り詰めも無い**（今の振る舞い）。土台にする記憶の `content` と `digest` を全部、そのまま
 * 並べる。`{ memoryIds }` の形は件数に上限が無いので、プロンプトは対象の本文の合計にほぼ比例して
 * 大きくなる（2026-09-27 の実測: 1000件×約1000字で約3.0MB。`@mnemora/anthropic` と
 * `@mnemora/openai` で同じ）。`{ query }`/`{ seedMemoryId }` の形は `recall()` の `limit` と
 * `maxCandidates` で件数が抑えられる。入力がモデルの上限を超えると、provider は API の拒否を
 * そのまま投げ、`outcome: "llm_failed"`（`llmFailure.kind: null`）になる——書き込みは0件である。
 *
 * Issue #1370: 新しい記憶の言語を、渡された記憶と同じ言語で書くよう明示する（無条件・
 * 録音済みカセットには使われていない文面——`buildExtractionPrompt` の
 * `subjectCandidates` 分岐と違い、`buildReflectionPrompt` は録音のキーに縛られない）。
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
   * **入力の順序をそのまま使う**——タグの和集合の並びと `provenance.sources` の並びはこの並びに従う
   * （`occurredAt` の最新判定・`subjectId` の一致判定は順序に依らない。`buildConsolidatedMemory` と同じ規律）。
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
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3・5:
   * `extraction.ts` の `BuildNewMemoryParams.activitySeq`/`halfLifeRecalls`・
   * `consolidate.ts` の `BuildConsolidatedMemoryParams` と同じ形。
   */
  activitySeq?: number | undefined;
  /** 活動時計のテナントの半減期（`recall()` の回数）。`activitySeq` と揃って渡したときだけ効く。 */
  halfLifeRecalls?: number | undefined;
}

/**
 * 新しい Memory の `NewMemory` を組み立てる純関数（Issue #104 手順7）。
 *
 * `strategies/consolidate.ts` の `buildConsolidatedMemory` の双子——`subjectId` の割れ方・
 * `digest` のフォールバック・`tags` の決め方・`occurredAt`・`halfLifeHours`・`decayFloorAt`・
 * `strength`・`embeddingStatus`・`sourceObservationId`/`extractorVersion` の扱いを
 * **全部そのまま踏襲する**。`consolidate` と `reflect` はどちらも「Observation に由来しない、
 * 複数の既存 Memory から新しい Memory を組み立てる」という同じ形の操作であり、この部分の
 * 意味論は統合か反映かで変わらない:
 *
 * - `subjectId`: eligible 全件の `subjectId` が一致すればその値、割れていれば `null`
 *   （`consolidate` と同じ——「この一般化は誰について言っているか」も、一致するときだけ
 *   引き継げる）。
 * - `digest`: LLM が返した digest が空・欠落なら機械的フォールバックへ倒す
 *   （`resolveDigest`、extraction.ts / consolidate.ts と同じ安全弁）。
 * - `tags`: LLM が返した `tags` があればそれ（空文字・空白だけの要素は `dropBlankTags` で捨てる）を使い、
 *   無ければ eligible の `tags` の和集合（重複は除く）。
 * - `attributes`: eligible 全件の積集合（`intersectAttributes`、ADR 0312 決定4）。
 * - `occurredAt`: eligible の `occurredAt` のうち最も新しいもの。全部 `null` なら `null`。
 * - `validFrom` / `validUntil`: eligible 全件の**区間の積**（`intersectValidity`、
 *   `validity.ts`。Issue #1188 残り、ADR 0368）——`validFrom` は最大値、`validUntil`
 *   は最小値。全部 `null` なら両方 `null`（今までの振る舞いのまま）。`consolidate` と
 *   違い、`reflect` は材料を `superseded` にしない——材料が期限切れになっても、材料
 *   自身の行はそのまま `active` で残り続ける（ADR 0368「代償」は `consolidate` 側だけの負債）。
 * - `halfLifeHours`: 呼び出し側（`runtime.reflect`）がテナント既定値から決めて渡す。
 *   `decayFloorAt`: この関数が `now`・`halfLifeHours` から `defaultDecayStrategy.floorAt` で計算する
 *   （`strength: 1` を前提。`consolidate` と同じ）。
 * - `strength`: **`1`（`MAX_STRENGTH`）に固定する。`consolidate` と同じ値・同じ書き方**
 *   ——`packages/core/src/provenance.ts` 冒頭の JSDoc が「オーナーの原則7は追加のフラグ
 *   ではなく `kind` の値そのものとして実装される」と明示しており、`strength` を下げると
 *   同じ区別を2本目の信号で複製することになる。ADR 0078 も「`Runtime` から初期値の
 *   `strength` を設定する口は開けない」と明示的に閉じている。
 * - `embeddingStatus`: 常に `'pending'`（`createMemoryWithOutbox` が `embed` ジョブを積む）。
 * - `sourceObservationId` / `extractorVersion`: 常に `null`（Observation 由来ではない）。
 * - `provenance`: `{ kind: 'reflected', sources: <eligible の memoryId> }`。**`sources` は
 *   常に埋める**——型としては `ReflectedProvenance.sources` は省略可のままだが（公開型の
 *   破壊的変更を避けるため、`provenance.ts` は変えていない）、この実装が作る値は常に埋める。
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

  // ADR 0165 決めたこと3・5: 活動時計の3つ組（`extraction.ts`/`consolidate.ts` と同じ規律）。
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
    // Issue #153（ADR 0312 決定4）: `consolidate` と同じ判断——積集合。
    // `intersectAttributes` は `strategies/consolidate.ts` と共有する（`reflect`/
    // `consolidate` は「複数の既存 Memory から新しい Memory を組み立てる」という
    // 同じ形の操作であり、`attributes` の引き継ぎ方をこの2経路で意図的に揃えた
    // ——本 PR の判断。同じ「似ている」の判定を発明しないのと同じ理由で、同じ
    // 「積集合」の判定も1箇所に置く）。
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
