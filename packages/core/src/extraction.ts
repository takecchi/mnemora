import { z } from "zod";
import type { Ctx } from "./ctx.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "./strategies/decay.js";
import type { LLMProvider, PromptSpec } from "./interfaces/llm-provider.js";
import type { DigestSource, NewMemory } from "./memory.js";
import type { Observation } from "./observation.js";
import type { Provenance } from "./provenance.js";

/**
 * 基本の Memory Extraction（roadmap.md 段階3、docs/architecture.md §3.8）。
 *
 * Observation → Memory 候補 + digest を `LLMProvider.completeStructured` で得る。
 * この核は `runtime.ts` から使われる純粋なロジックであり、`LLMProvider` は注入される
 * （core は OpenAI/Anthropic の型を知らない、docs/architecture.md §3.8）。
 */

/** LLM に返させる、1件の Memory 候補の構造化スキーマ。 */
export const ExtractedMemoryCandidateSchema = z.object({
  content: z.string().min(1),
  /**
   * 要旨。LLM が生成できなかった場合は省略してよい（省略・空文字は「LLM 側の digest 生成が
   * 失敗した」ものとして扱い、機械的な先頭文字列切り出しへフォールバックする。
   * docs/memory-model.md §4 の安全弁）。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * この候補の主題（Issue #608 項目①）。**省略（undefined）＝未指定**——`buildNewMemoryFromCandidate`
   * が従来どおり `observation.subjectId` へ落ちる。**明示的な `null` ＝主題なしを明示**——
   * observation 側が値を持っていても、それを上書きして主題を持たない Memory にする
   * （Issue 本文の例:「Aさん『明日台風来るらしいよ』→ 明日台風が来る 主題 = なし」）。
   * `Memory.subjectId` / `Observation.subjectId` と同じ `string | null | undefined` の型を使う
   * （`memory.ts` / `observation.ts` の同名欄と同じ規約）。
   *
   * 1回の `observe()` から複数候補が抽出されると、**候補ごとに違う主題を持てる**——
   * 同じ observation を全候補へ渡す `buildNewMemoriesForCandidates`（runtime.ts）の下でも、
   * この欄だけは候補ごとに独立している。
   */
  subjectId: z.string().min(1).nullable().optional(),
  /**
   * オーナーの原則7（AI の推論とユーザーが言った事実を区別する）。抽出結果は必ず
   * `stated`（本人が明示的に述べた事実）か `inferred`（LLM の推論）のどちらかを申告する。
   */
  provenanceKind: z.enum(["stated", "inferred"]),
  /** `provenanceKind: 'inferred'` のときの確信度。`stated` では無視する。 */
  confidence: z.number().min(0).max(1).optional(),
});
export type ExtractedMemoryCandidate = z.infer<typeof ExtractedMemoryCandidateSchema>;

export const ExtractionResultSchema = z.object({
  memories: z.array(ExtractedMemoryCandidateSchema),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

function observationPayloadText(observation: Observation): string {
  const payload = observation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) {
      return record.text;
    }
    if (typeof record.content === "string" && record.content.length > 0) {
      return record.content;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
  }
  return JSON.stringify(payload ?? null);
}

function observationSpeaker(observation: Observation): string | undefined {
  const payload = observation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const speaker = (payload as Record<string, unknown>).speaker;
    if (typeof speaker === "string" && speaker.length > 0) {
      return speaker;
    }
  }
  return undefined;
}

/**
 * 抽出プロンプトの system 文面の基底部分。**この定数の文字列は Issue #608 項目②(b) の
 * 前後で1バイトも変えていない**——`buildExtractionPrompt` は `subjectCandidates` が
 * 渡されなかった（省略・空配列）呼び出しでは、この文字列をそのまま返す。カセット
 * （ADR 0051）の照合鍵 `llmCassetteKey` は `PromptSpec`（`system` + `messages`）だけで
 * 決まるため、既存の呼び出し（`subjectCandidates` を渡さない全ての録音済みシナリオ）の
 * 鍵はこの変更で動かない（Issue #370/#371 への配慮。ADR 0271 前提1と同じ実測手順で
 * 確かめている——本 PR の ADR 参照）。
 */
const EXTRACTION_PROMPT_SYSTEM_BASE =
  "あなたは会話・イベント・文書から再利用可能な記憶を抽出するアシスタントです。" +
  "本人が明示的に述べた事実は provenanceKind: 'stated' として、それ以外の推論は " +
  "'inferred' として区別してください。何も記憶に値しない場合は空配列を返してください。";

/**
 * Issue #608 項目②(b): 候補一覧が渡されたときだけ、system 文面へ足す指示。
 *
 * ADR 0271「引き受けた負債1」の申し送り——「②を実装する側は、プロンプトが
 * 『主題が無いなら明示的に `null` を返せ』と指示する形にする必要がある」——を
 * そのまま実装する。**候補一覧を書く（表記ゆれを止める、Issue 本文の目的）**のと、
 * **`null` を明示させる（①の `null`/`undefined` の線引きを実地で踏ませる）**のと、
 * 両方を1つの指示にまとめる。
 */
function buildSubjectCandidateInstruction(subjectCandidates: readonly string[]): string {
  return (
    `この観測には主題（subjectId）の候補一覧が渡されています: ${subjectCandidates.join(", ")}。` +
    "各記憶候補の subjectId には、この一覧の中から最も当てはまるものを1つだけ設定してください。" +
    "一覧のどれにも当てはまらない場合、またはその記憶が主題を持たない場合は、" +
    "その候補の subjectId に明示的に null を設定してください（省略しないでください）。"
  );
}

/** `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約はスキーマ側にある。 */
export function buildExtractionPrompt(
  observation: Observation,
  subjectCandidates?: readonly string[],
): PromptSpec {
  // Issue #608 項目②(b): 空配列は「渡していない」と同じ——`SubjectCandidatesInput` の
  // doc コメント（observation.ts）参照。ここで弾かないと、空配列を渡しただけで
  // `EXTRACTION_PROMPT_SYSTEM_BASE` と1バイトも違わない文面のはずが、空の一覧文言
  // （`候補一覧が渡されています: `）を余計に足してしまう。
  const hasCandidates = subjectCandidates !== undefined && subjectCandidates.length > 0;
  const system = hasCandidates
    ? `${EXTRACTION_PROMPT_SYSTEM_BASE} ${buildSubjectCandidateInstruction(subjectCandidates)}`
    : EXTRACTION_PROMPT_SYSTEM_BASE;
  return {
    system,
    messages: [
      {
        role: "user",
        content: observationPayloadText(observation),
      },
    ],
  };
}

/**
 * 機械的な先頭文字列切り出し（docs/memory-model.md §4 の安全弁）。
 * `content` は生成の成否に関わらず常に保持される前提で、`digest` だけをこの関数で埋める。
 */
export function truncateForFallbackDigest(content: string, maxLength: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) {
    return trimmed.length > 0 ? trimmed : "（内容なし）";
  }
  return `${trimmed.slice(0, maxLength)}…`;
}

export interface ResolvedDigest {
  digest: string;
  digestSource: DigestSource;
}

/** LLM が返した digest が空・欠落なら機械的フォールバックへ倒す（1件ずつの判定）。 */
export function resolveDigest(
  candidate: Pick<ExtractedMemoryCandidate, "content" | "digest">,
  fallbackLength: number,
): ResolvedDigest {
  const llmDigest = candidate.digest?.trim();
  if (llmDigest && llmDigest.length > 0) {
    return { digest: llmDigest, digestSource: "llm" };
  }
  return {
    digest: truncateForFallbackDigest(candidate.content, fallbackLength),
    digestSource: "fallback",
  };
}

/**
 * LLM 呼び出し自体が失敗した場合の安全弁: Observation の全文をそのまま1件の `stated` Memory
 * として残す。**content（全文）は生成の成否に関わらず必ず書く**という規律（docs/memory-model.md
 * §4）を、抽出全体が失敗した場合にも一貫させる（曖昧なら厚い側に倒す）。
 */
function fallbackWholeObservationCandidate(observation: Observation): ExtractedMemoryCandidate {
  return {
    content: observationPayloadText(observation),
    tags: [],
    provenanceKind: "stated",
  };
}

/**
 * 抽出がどう終わったか（ADR 0008 の「無い」の分類を、recall だけでなく取り込み側にも適用する）。
 *
 * - `ok` — LLM が正常に応答した。**0件を返した場合も `ok`** である
 *   （何も記憶に値しないという判断は正常な抽出結果であり、失敗ではない）。
 * - `llm_failed_whole_observation` — LLM 呼び出し自体が失敗し、Observation の全文を
 *   1件の Memory として残す安全弁へ倒れた（docs/memory-model.md §4「曖昧なら厚い側に倒す」）。
 *   **この Memory は「抽出された」ものではない。** 未処理の生テキストである。
 * - `skipped` — この呼び出しでは抽出を実行していない（`deferred`、`memory_usage`、冪等な再送）。
 */
export type ExtractionOutcome = "ok" | "llm_failed_whole_observation" | "skipped";

/**
 * `extractCandidates` が LLM 呼び出しの例外を飲んだとき、**中身だけは捨てずに運ぶ**ための形。
 *
 * 背景: `ExtractionOutcome: "llm_failed_whole_observation"` という1つの値に、実測で
 * 少なくとも6種の原因（拒否 / 切り詰め / 空応答 / `ZodError` / `SyntaxError` / 通信・認証
 * エラー）が畳まれていた。「例外を上へ伝播させない」こと自体は ADR 0013 の意図的な決定
 * （安全弁）であり維持するが、「中身まで捨てる」ことを決めた記述はどこにも無い。
 */
export interface ExtractionFailure {
  /**
   * provider が名乗った種類（`@mnemora/openai` / `@mnemora/anthropic` が投げるエラーの
   * `kind`）。**名乗っていなければ `null`**——「分からない」を勝手な種類に読み替えない。
   */
  kind: string | null;
  /** 例外のメッセージ（人が読むため）。 */
  message: string;
}

/**
 * 任意の `throw` された値から `ExtractionFailure` を組み立てる。
 *
 * ⚠ **core は provider のクラスを知らない**（`packages/core/package.json` の
 * `dependencies` は `zod` だけ、`dependency-boundary.test.ts` が機械的に検査している）。
 * そのため `instanceof AnthropicLLMProviderError` のような判定はできず、**値として
 * `error.kind` を読む**（duck typing）。`kind` は `typeof === "string"` かつ空文字でない
 * ときだけ採り、それ以外（無い・数値・空文字など）は `null` にする——「分からない」を
 * 勝手な種類に読み替えないため。
 *
 * `message` は `error instanceof Error ? error.message : String(error)` に相当する。
 * **非 `Error`（文字列・`undefined`・プレーンオブジェクト等）が投げられても落ちない。**
 */
export function describeExtractionFailure(error: unknown): ExtractionFailure {
  const rawKind = (error as { kind?: unknown } | null | undefined)?.kind;
  const kind = typeof rawKind === "string" && rawKind.length > 0 ? rawKind : null;
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message };
}

export interface ExtractCandidatesResult {
  candidates: ExtractedMemoryCandidate[];
  /** LLM 呼び出し自体が失敗し、全文フォールバックへ倒れたかどうか。 */
  usedWholeObservationFallback: boolean;
  /**
   * LLM 呼び出しが失敗した理由。**成功経路（0件を含む）は必ず `null`。**
   * 失敗経路（`usedWholeObservationFallback: true`）は必ず非 `null`。
   */
  failure: ExtractionFailure | null;
  /**
   * Issue #608 項目②(b): `subjectCandidates` が渡されたとき、LLM が返した `subjectId` の
   * うち**一覧に無かった文字列**（弾く前の値、弾いた順）。`sanitizeCandidateSubjectId` が
   * 弾いた候補は `candidates` の該当要素の `subjectId` から既に取り除かれている（`undefined`
   * ＝未指定へ戻り、`buildNewMemoryFromCandidate` が observation の値へフォールバックする）
   * ——**この欄は「黙って戻さない」ための記録専用**であり、`candidates` の中身には影響しない。
   *
   * **本ファイル内の2箇所（成功経路・失敗経路）は、この PR で両方とも必ず値を埋める**
   * ため、実際に `undefined` になることは無い（渡さなかった・空配列だった・何も弾かれ
   * なかった、いずれも `[]`）。⚠ **型としては optional にする**——`docs/decisions/
   * 0178-public-api-surface-gate.md` が「新しい任意プロパティの追加」だけを semver 的に
   * 安全と定めているため、既存の型（`ExtractCandidatesResult`）に**必須**プロパティを
   * 足すと、この型を自前で実装している外部コード（`extractCandidates` を模す独自の
   * テストダブル等）がコンパイルできなくなる可能性がある。ADR 0271 が
   * `ExtractedMemoryCandidateSchema.subjectId` を同じ理由で optional にしたのと同じ判断。
   */
  rejectedSubjectIds?: string[];
}

/**
 * Issue #608 項目②(b): LLM が返した1候補の `subjectId` を、呼び出し側が渡した
 * `subjectCandidates` に照らして検証する。
 *
 * - `subjectId` が `undefined`（省略）または `null`（明示的な「主題なし」）なら、
 *   一覧の有無に関わらず常に有効——`null` は「一覧のどれか」ではなく「主題を持たない」
 *   という別の値であり、一覧に含まれている必要が無い。
 * - `allowedSubjectCandidates` が `undefined` または空配列なら、検証しようがないので
 *   常に有効（`SubjectCandidatesInput` の「空配列＝渡していないと同じ」規約、
 *   observation.ts 参照）。**この分岐により `reextract`（候補一覧を持たない）や
 *   ①だけの既存呼び出しは、この関数を通しても1バイトも挙動が変わらない。**
 * - それ以外（一覧が渡されていて、`subjectId` が非 null 文字列）は、一覧に含まれるかを
 *   検査する。含まれていれば有効。**含まれていなければ弾き、`undefined`（未指定）を返す**
 *   ——①の「省略」経路と同じ着地点で、`buildNewMemoryFromCandidate` が
 *   `observation.subjectId` へフォールバックする。
 */
export function sanitizeCandidateSubjectId(
  subjectId: string | null | undefined,
  allowedSubjectCandidates: readonly string[] | undefined,
): { subjectId: string | null | undefined; rejected: boolean } {
  if (subjectId === undefined || subjectId === null) {
    return { subjectId, rejected: false };
  }
  if (allowedSubjectCandidates === undefined || allowedSubjectCandidates.length === 0) {
    return { subjectId, rejected: false };
  }
  if (allowedSubjectCandidates.includes(subjectId)) {
    return { subjectId, rejected: false };
  }
  return { subjectId: undefined, rejected: true };
}

/**
 * `extractCandidates` の成功経路が返す前に、LLM の生の応答（`result.memories`）へ
 * `sanitizeCandidateSubjectId` を適用する（Issue #608 項目②(b)）。
 *
 * `usedWholeObservationFallback: true`（LLM 呼び出し自体が失敗し、
 * `fallbackWholeObservationCandidate` を使う経路）はここを通らない——安全弁で作る
 * 候補は `subjectId` を持たない（`fallbackWholeObservationCandidate` 参照）ため、
 * 検証する対象が無い。
 */
function sanitizeExtractionCandidates(
  candidates: ExtractedMemoryCandidate[],
  subjectCandidates: readonly string[] | undefined,
): { candidates: ExtractedMemoryCandidate[]; rejectedSubjectIds: string[] } {
  const rejectedSubjectIds: string[] = [];
  const sanitized = candidates.map((candidate) => {
    const result = sanitizeCandidateSubjectId(candidate.subjectId, subjectCandidates);
    if (!result.rejected) {
      return candidate;
    }
    // `candidate.subjectId` はここでは非 null 文字列であることが確定している
    // （`sanitizeCandidateSubjectId` が `rejected: true` を返すのはその場合だけ）。
    rejectedSubjectIds.push(candidate.subjectId as string);
    return { ...candidate, subjectId: result.subjectId };
  });
  return { candidates: sanitized, rejectedSubjectIds };
}

/**
 * `LLMProvider.completeStructured` を呼び、失敗したら全文フォールバックへ倒す。
 *
 * **LLM が正常に「0件」を返した場合はフォールバックしない。** 何も記憶に値しないという判断は
 * 正常な抽出結果であり、これを「失敗」として無理に1件作ると、北極星の物差し（毎回渡す量を
 * 減らす方向に働くか）に反するゴミ記憶を増やす。フォールバックの対象はあくまで
 * **LLM 呼び出し自体が失敗した場合**（ネットワークエラー・タイムアウト・スキーマ不整合等）。
 *
 * `subjectCandidates`（Issue #608 項目②(b)）を渡すと、`buildExtractionPrompt` の文面に
 * 候補一覧と null の指示が足され、LLM の応答は `sanitizeExtractionCandidates` で検証
 * された後に返る。省略・空配列なら、プロンプトも検証も従来どおり（1バイトも変わらない）。
 */
export async function extractCandidates(
  llmProvider: LLMProvider,
  ctx: Ctx,
  observation: Observation,
  subjectCandidates?: readonly string[],
): Promise<ExtractCandidatesResult> {
  try {
    const result = await llmProvider.completeStructured(ctx, {
      prompt: buildExtractionPrompt(observation, subjectCandidates),
      schema: ExtractionResultSchema,
    });
    const sanitized = sanitizeExtractionCandidates(result.memories, subjectCandidates);
    return {
      candidates: sanitized.candidates,
      usedWholeObservationFallback: false,
      failure: null,
      rejectedSubjectIds: sanitized.rejectedSubjectIds,
    };
  } catch (error) {
    return {
      candidates: [fallbackWholeObservationCandidate(observation)],
      usedWholeObservationFallback: true,
      failure: describeExtractionFailure(error),
      rejectedSubjectIds: [],
    };
  }
}

export interface BuildNewMemoryParams {
  ctx: Ctx;
  observation: Observation;
  candidate: ExtractedMemoryCandidate;
  hashContent: (content: string) => string;
  extractorVersion: string;
  llmModelId: string;
  promptVersion: string;
  halfLifeHours: number;
  now: Date;
  digestFallbackLength: number;
  /**
   * [ADR 0165](../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3・5:
   * 書き込み時点の `tenant_activity.activity_seq`（テナントの `decay_clock` が
   * `'wall'` 以外のときだけ呼び出し側が渡す）。`halfLifeRecalls` と対で渡すこと——
   * 片方だけ渡しても活動時計の3つ組は作られない（下記 `halfLifeRecalls` 参照）。
   */
  activitySeq?: number;
  /**
   * [ADR 0165](../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3:
   * この Memory の活動時計での半減期（単位: recall 回数）。**`activitySeq` と両方
   * 揃っていないと、活動時計の3つ組（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）は
   * 作られない**——`'wall'` のテナントでは呼び出し側がどちらも渡さず、3つとも
   * `undefined` のまま Memory に書かれる（ADR 0165 決めたこと5「`'wall'` のテナントでは
   * 何も増えない」）。
   */
  halfLifeRecalls?: number;
}

function buildProvenance(params: BuildNewMemoryParams): Provenance {
  const { candidate, observation } = params;
  if (candidate.provenanceKind === "inferred") {
    return {
      kind: "inferred",
      model: params.llmModelId,
      promptVersion: params.promptVersion,
      basis: { memoryIds: [], observationIds: [observation.id] },
      confidence: candidate.confidence ?? 0.5,
    };
  }
  const speaker = observationSpeaker(observation);
  return {
    kind: "stated",
    sourceObservationId: observation.id,
    at: (observation.occurredAt ?? observation.recordedAt).toISOString(),
    ...(speaker !== undefined ? { speaker } : {}),
  };
}

/** 1件の抽出候補から `NewMemory` を組み立てる（D16: contentHash は注入された関数で計算する）。 */
export function buildNewMemoryFromCandidate(params: BuildNewMemoryParams): NewMemory {
  const { digest, digestSource } = resolveDigest(params.candidate, params.digestFallbackLength);
  const decayFloorAt = defaultDecayStrategy.floorAt({
    recordedAt: params.now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
  });
  // ADR 0165 決めたこと3・5: 活動時計の3つ組。`activitySeq`/`halfLifeRecalls` の両方が
  // 揃っているときだけ作る——入力が無ければ3つとも undefined のまま（'wall' のテナント）。
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
    // Issue #608 項目①: 候補の subjectId を優先する。`undefined`（省略・未指定）のときだけ
    // 従来どおり observation の値へ落ちる。`null`（明示的な「主題なし」）は observation の値が
    // あってもそのまま通す——上書きしてしまうと「主題なしを明示した」候補が書けなくなる。
    subjectId:
      params.candidate.subjectId !== undefined
        ? params.candidate.subjectId
        : (params.observation.subjectId ?? null),
    sourceObservationId: params.observation.id,
    extractorVersion: params.extractorVersion,
    content: params.candidate.content,
    contentHash: params.hashContent(params.candidate.content),
    digest,
    digestSource,
    provenance: buildProvenance(params),
    tags: params.candidate.tags ?? [],
    occurredAt: params.observation.occurredAt ?? null,
    recordedAt: params.now,
    lastReinforcedAt: null,
    // Issue #280: `occurredAt` と同じ経路で `Observation` から素通しする
    // （`Observation.validFrom`/`validUntil` の doc コメント参照）。1回の `observe()`
    // から複数候補が抽出されると、全候補が同じ区間を共有する（`occurredAt` と同型の限界）。
    validFrom: params.observation.validFrom ?? null,
    validUntil: params.observation.validUntil ?? null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
    decayFloorAt,
    decayBaseSeq,
    decayFloorSeq,
    halfLifeRecalls: hasActivityInputs ? params.halfLifeRecalls : undefined,
    embeddingStatus: "pending",
  };
}
