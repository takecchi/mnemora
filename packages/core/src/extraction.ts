import { z } from "zod";
import { isAbort, runAbortable } from "./abort.js";
import type { ClaimKey } from "./claim-key.js";
import type { Ctx } from "./ctx.js";
import { findMalformedIdentifierPart } from "./identifier.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "./strategies/decay.js";
import { resolveCandidateSubjectId } from "./memory-subject.js";
import type { LLMProvider, PromptSpec } from "./interfaces/llm-provider.js";
import type { DigestSource, NewMemory } from "./memory.js";
import { observationPayloadText } from "./observation-text.js";
import type { Observation } from "./observation.js";
import { ExtractionContextSchema } from "./observation.js";
import { assertLLMContentNotBlank } from "./llm-content.js";
import type { Provenance } from "./provenance.js";
import { dropBlankTags } from "./llm-tags.js";
import { sliceAtGraphemeBoundary } from "./text-truncation.js";

/**
 * 基本の Memory Extraction（docs/architecture.md §3.8）。
 *
 * Observation → Memory 候補 + digest を `LLMProvider.completeStructured` で得る。`runtime.ts` から使われる純粋な
 * ロジックで、`LLMProvider` は注入される（core は OpenAI/Anthropic の型を知らない）。
 */

/** LLM に返させる、1件の Memory 候補の構造化スキーマ。 */
export const ExtractedMemoryCandidateSchema = z.object({
  content: z.string().min(1),
  /**
   * 要旨。LLM が生成できなかった場合は省略してよい（省略・空文字・`trim` で空になる値は「LLM 側の digest 生成が失敗した」
   * ものとして扱い、機械的な先頭文字列切り出しへフォールバックする（`resolveDigest`。docs/memory-model.md §4 の安全弁））。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * この候補の主題。**省略（undefined）＝未指定**: `buildNewMemoryFromCandidate` が `observation.subjectId` へ落ちる。
   * **明示的な `null` ＝主題なしを明示**: observation 側が値を持っていても、それを上書きして主題を持たない Memory にする。
   * `Memory.subjectId` / `Observation.subjectId` と同じ `string | null | undefined` の型を使う。
   *
   * 1回の `observe()` から複数候補が抽出されると、**候補ごとに違う主題を持てる**。
   *
   * ⚠ **`@mnemora/openai` では、明示の `null`（主題なし）が core に届かない。**OpenAI の strict モードは「省略可能」を
   * 「必須かつ `null` 可」に翻訳するので、応答の `null` だけでは「未指定」と「主題なし」を区別できず、
   * `OpenAILLMProvider.completeStructured` はすべての `null` をキーごと消してから（`stripNulls`）このスキーマに渡す。
   * モデルが指示どおり `null` を返しても**省略（未指定）として届き、Memory は observation の主題を持つ**。
   * `@mnemora/anthropic` は `null` を保つので、主題なしの Memory になる。`subjectCandidates` を渡して「主題なし」を
   * 選ばせる使い方は、`@mnemora/anthropic`（か、`null` を保つ自前の provider）でだけ効く。
   *
   * ⚠ **`subjectCandidates` を渡さない経路（省略・空配列。`tick`・`reextract` を含む）では、runtime は LLM が返した
   * `subjectId` を既定で捨てる**（observation の `subjectId` へ落ちる。
   * [ADR 0635](../../../docs/decisions/0635-llm-subject-id-dropped-by-default-without-candidates.md)）。受けるのは
   * `RuntimeConfig.acceptLlmSubjectIdWithoutCandidates: true`（opt-in）のときだけで、**以下の警告は `true` にしたときの話である。**
   * 一覧を渡した `observe()` は一覧に照らす。この関数（`extractCandidates`）自体は捨てない。
   *
   * ⚠ **opt-in のとき、LLM が返した文字列の `subjectId` をそのまま受ける**（[ADR 0442](../../../docs/decisions/0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)）。
   * 検証は `subjectCandidates` の一覧に照らすことでしか行わない（{@link sanitizeCandidateSubjectId}。ただし NUL・孤立サロゲートを
   * 含む識別子だけは、一覧の有無に関わらず弾く。ADR 0456）ので、一覧を渡さない呼び出し（一覧を持てない
   * `extract: 'deferred'` の `tick`・`reextract` を含む）では、observation や `ctx` の `subjectId` と違う値でも、そのまま
   * Memory の主題になる。⟹ 観察文に「この記憶の主題は bob」のような文を書いて LLM に言わせる**注入**で、同じテナントの
   * **別の subject** に記憶を書かせられる。`claimKey: { enabled: true, detectContested: true }` を併用していると、その subject が
   * 既に持っている active な記憶が `contested` に変わりうる（`@mnemora/postgres` と testkit のインメモリの両方で確認）。
   * テナントの境界は越えない。信用できない本文を抽出するなら、`subjectCandidates` を渡して選ばせること。
   */
  subjectId: z.string().min(1).nullable().optional(),
  /**
   * AI の推論とユーザーが言った事実を区別する。抽出結果は必ず `stated`（本人が明示的に述べた事実）か
   * `inferred`（LLM の推論）のどちらかを申告する。
   */
  provenanceKind: z.enum(["stated", "inferred"]),
  /** `provenanceKind: 'inferred'` のときの確信度。`stated` では無視する。省略なら `0.5` で `provenance.confidence` に入る（`buildNewMemoryFromCandidate`）。 */
  confidence: z.number().min(0).max(1).optional(),
});
/** 抽出の LLM が返す記憶の候補1件（{@link ExtractedMemoryCandidateSchema} の型）。 */
export type ExtractedMemoryCandidate = z.infer<typeof ExtractedMemoryCandidateSchema>;

/** 抽出の LLM に返させる値の zod スキーマ（`memories` は候補の配列。0件もありうる）。 */
export const ExtractionResultSchema = z.object({
  memories: z.array(ExtractedMemoryCandidateSchema),
});
/** {@link ExtractionResultSchema} の型。 */
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

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
 * 抽出プロンプトの system 文面の基底部分。**この定数の文字列は変えない。**`buildExtractionPrompt` は `subjectCandidates` が
 * 渡されなかった（省略・空配列）呼び出しでは、この文字列をそのまま返す。カセット（ADR 0051）の照合鍵 `llmCassetteKey` は
 * `PromptSpec`（`system` + `messages`）だけで決まるため、1バイトでも変えると録音済みシナリオの鍵が動く。
 * 言語・話者の指示（{@link buildLanguageAndSpeakerInstruction}）もこの定数へは足さず、`subjectCandidates` が渡された
 * ときだけ足す。
 */
const EXTRACTION_PROMPT_SYSTEM_BASE =
  "あなたは会話・イベント・文書から再利用可能な記憶を抽出するアシスタントです。" +
  "本人が明示的に述べた事実は provenanceKind: 'stated' として、それ以外の推論は " +
  "'inferred' として区別してください。何も記憶に値しない場合は空配列を返してください。";

/**
 * 候補一覧が渡されたときだけ、system 文面へ足す指示。候補一覧を書く（表記ゆれを止める）のと、**`null` を明示させる**
 * （主題が無いなら省略ではなく明示的な `null`、という線引きを踏ませる）のを、1つの指示にまとめる（ADR 0271）。
 */
function buildSubjectCandidateInstruction(subjectCandidates: readonly string[]): string {
  return (
    `この観測には主題（subjectId）の候補一覧が渡されています: ${subjectCandidates.join(", ")}。` +
    "各記憶候補の subjectId には、この一覧の中から最も当てはまるものを1つだけ設定してください。" +
    "一覧のどれにも当てはまらない場合、またはその記憶が主題を持たない場合は、" +
    "その候補の subjectId に明示的に null を設定してください（省略しないでください）。"
  );
}

/**
 * `subjectCandidates` が渡されたときだけ足す、出力言語と話者取り違えの指示。
 *
 * **`EXTRACTION_PROMPT_SYSTEM_BASE` 自体にも `extractionContext` 分岐にも足さない。**BASE を1バイトでも変えると記録済み
 * カセット（`examples/chat/cassettes/`）の `llmCassetteKey`（ADR 0051）が全部動き、`extractionContext` 分岐の文面を
 * 変えると `extraction-context*.test.ts` の録音再生テストが壊れる。`subjectCandidates` を渡す呼び出し（録音に無い）に
 * だけ足すことで、両方の鍵を動かさずに直す。既定経路へも広げるかはオーナー判断待ち（CHANGELOG `[1.1.0]`）。
 *
 * 話者の一文は、`extractionContext` も同時に渡したときに直後へ続く既存の一文「他の話者の発言を対象話者の事実として
 * 抽出しないでください」と向きが逆で補い合う（既存は他者→対象話者の誤帰属、ここは対象話者→他者の誤帰属を止める）。
 */
function buildLanguageAndSpeakerInstruction(): string {
  return (
    "記憶の本文（content）と要旨（digest）は、観測の本文と同じ言語で書いてください" +
    "（subjectId や provenanceKind などの識別子はこの限りではありません）。" +
    "観測の発言の話者（本文の先頭の話者ラベル、または speaker）自身の発言は、" +
    "その話者についての記憶として扱い、別の人物（利用者など）の発言・意見として書かないでください。"
  );
}

interface CalendarDate {
  /** 天文学年（1 BC = 0、2 BC = -1）。 */
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** `timeZone` での `at` の暦日（ADR 0440）。`Intl` の年の書き方の癖は {@link buildExtractionPrompt} の中の注を参照。 */
function localCalendarDate(at: Date, timeZone: string): CalendarDate | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  // `en-CA`（gregory）の era は "AD" / "BC"。紀元前の年は 1 から数える。
  return { year: get("era") === "BC" ? 1 - year : year, month, day };
}

/** `Date#toISOString` の日付部分と同じ書き方（0〜9999 年は4桁、それ以外は符号付き6桁）。 */
function formatCalendarDate(date: CalendarDate): string {
  const { year } = date;
  const y =
    year >= 0 && year <= 9999
      ? String(year).padStart(4, "0")
      : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
  return `${y}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** 暦日に `offsetDays` を足した暦日の文字列。`Date` の範囲（±8.64e15 ms）を出るときは null。 */
function shiftedCalendarDate(date: CalendarDate, offsetDays: number): string | null {
  const base = new Date(0);
  base.setUTCFullYear(date.year, date.month - 1, date.day);
  const shifted = new Date(base.getTime() + offsetDays * 86400000);
  if (Number.isNaN(shifted.getTime())) return null;
  const iso = shifted.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}

/**
 * `completeStructured` へ渡すプロンプト。契約はスキーマ側にある。
 *
 * ⚠ **観測の本文は切り詰めずに、そのまま入れる**（`observe()` の入力にも上限は無い）。プロンプトの大きさは本文にほぼ
 * 比例する（約1MB の本文で、送るリクエストは約1.05MB）。`extractionContext` は `ExtractionContextSchema` が件数と長さを
 * 抑えるので、足される量は約50KB まで。入力がモデルの上限を超えると、provider は API の拒否をそのまま投げ（分類の `kind` は
 * 付かない。各 provider の `errors.ts` 参照）、抽出は LLM の失敗として全文フォールバックへ倒れる。本文は1文字も落ちずに
 * 1件の Memory として残る。
 * ⚠ **`@mnemora/postgres` も testkit の fixture も、tsvector が1MBを超える大きな本文を、1文字も落とさず1件の Memory として
 * 残す**（`idx_memories_lexical` の式に、1MBを超える本文だけ先頭150,000文字（`SQL_ASCII` の DB ではバイト）で作り直す
 * フォールバックを挟んである。`mnemora_lexical_tsvector`、[ADR 0364](../../../docs/decisions/0364-lexical-tsvector-fallback-for-oversized-content.md)）。
 * `memories.content` は無傷のまま全文を保存し、縮退するのは語彙**索引**だけ。150,000文字より後ろにしか現れない語は
 * `LexicalStore`（語彙チャンネル）からは引けない（ベクトル検索等、他の recall チャンネルには影響しない）。
 */
export function buildExtractionPrompt(
  observation: Observation,
  subjectCandidates?: readonly string[],
): PromptSpec {
  // 空配列は「渡していない」と同じ（`SubjectCandidatesInput` の doc）。ここで弾かないと、空配列を渡しただけで
  // BASE と1バイトも違わないはずの文面に、空の一覧文言を余計に足してしまう。
  const hasCandidates = subjectCandidates !== undefined && subjectCandidates.length > 0;
  let system = hasCandidates
    ? `${EXTRACTION_PROMPT_SYSTEM_BASE} ${buildSubjectCandidateInstruction(subjectCandidates)} ` +
      buildLanguageAndSpeakerInstruction()
    : EXTRACTION_PROMPT_SYSTEM_BASE;
  const payload = observation.payload;
  const rawContext =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).extractionContext
      : undefined;
  let content = observationPayloadText(observation);
  // 話者の一文（buildLanguageAndSpeakerInstruction）は「本文の先頭の話者ラベル、または speaker」と言う。extractionContext が
  // 無いと user 入力は本文だけで payload.speaker が見えないので、**候補あり・extractionContext 無し・speaker ありのときだけ**、
  // 本文の前に1行足す。候補なし（既定経路）と extractionContext 分岐（JSON の observation.speaker に既に出ている）は
  // 1バイトも変えない（カセット鍵を動かさない）。
  if (hasCandidates && rawContext === undefined) {
    const speaker = observationSpeaker(observation);
    if (speaker !== undefined) {
      content = `話者（speaker）: ${speaker}\n\n${content}`;
    }
  }
  if (rawContext !== undefined) {
    const context = ExtractionContextSchema.parse(rawContext);
    system +=
      " 入力JSONのobservationだけを抽出対象にしてください。contextは参照先の解決にだけ使い、" +
      "他の話者の発言を対象話者の事実として抽出しないでください。代名詞は文脈で一意に分かる場合だけ具体化し、" +
      "分からない対象を補わないでください。直前の提案への明示的な同意・選択は、選択した具体的内容を対象話者の記憶として残してください。" +
      "相対日付はoccurredAtとtimeZoneが両方ある場合だけobservedLocalDateを基準に暦日に具体化し、明日・昨日はrelativeDatesの計算済み日付を使ってください。" +
      "記録日時recordedAtを発話日時の代わりに使わないでください。情報が足りなければ不明であることを本文に残してください。";
    system += " digestにも対象・話者・確定できた日付など回答に必要な情報を残してください。";
    // `Intl.DateTimeFormat#format` は年を4桁に0詰めせず（"999-06-01"・"10000-01-01"）、紀元前は符号を落とす（天文学年 0 が "1"、
    // -100 が "101"）。その文字列を `Date.parse` に渡すと NaN になり、全文フォールバックへ黙って倒れる（ADR 0440）。そのため年月日は
    // `formatToParts` で取り、`era` で紀元前を符号付きの天文学年（1 BC = 0）へ戻し、`setUTCFullYear` で組み直す。
    // プロンプトに出す暦日の書き方は `Date#toISOString` と同じ（0〜9999 年は4桁に0詰め、範囲外は ±6桁）。
    const localParts =
      observation.occurredAt && context.timeZone
        ? localCalendarDate(observation.occurredAt, context.timeZone)
        : null;
    const localDate = localParts === null ? null : formatCalendarDate(localParts);
    const relativeDates =
      localParts === null
        ? null
        : Object.fromEntries(
            [
              ["昨日", -1],
              ["今日", 0],
              ["明日", 1],
              ["明後日", 2],
            ].map(([label, offset]) => [label, shiftedCalendarDate(localParts, Number(offset))]),
          );
    content = JSON.stringify({
      observation: {
        text: content,
        speaker: observationSpeaker(observation) ?? null,
        subjectId: observation.subjectId ?? null,
        occurredAt: observation.occurredAt?.toISOString() ?? null,
        recordedAt: observation.recordedAt.toISOString(),
        observedLocalDate: localDate,
        relativeDates,
      },
      context: context.messages ?? [],
      timeZone: context.timeZone ?? null,
    });
  }
  return {
    system,
    messages: [
      {
        role: "user",
        content,
      },
    ],
  };
}

/**
 * 機械的な先頭文字列切り出し（docs/memory-model.md §4 の安全弁）。
 * `content` は生成の成否に関わらず常に保持される前提で、`digest` だけをこの関数で埋める。
 *
 * 負の `maxLength` は `0` として扱う（本文が空のときも。空なら `"（内容なし）"`、空でなければ `"…"`）。
 * `NaN` も本文を残さない（`"…"` だけ。`RuntimeConfig.digestFallbackLength` の doc）。
 *
 * 切るのは書記素の境界（ADR 0467、`sliceAtGraphemeBoundary`）。`maxLength` が結合文字や ZWJ 絵文字・国旗の途中に落ちたら、
 * その書記素の手前で止める。
 */
export function truncateForFallbackDigest(content: string, maxLength: number): string {
  const trimmed = content.trim();
  // 負の上限は上限0（本文を残さない）として扱う（本文が空のときも `maxLength: 0` と結果を揃える）。
  const limit = maxLength < 0 ? 0 : maxLength;
  if (trimmed.length <= limit) {
    return trimmed.length > 0 ? trimmed : "（内容なし）";
  }
  // `String.prototype.slice(0, n)` は n が負数だと「末尾から n 文字を除く」という別の意味になるので、負数は上限0として扱う。
  // `sliceAtGraphemeBoundary` は NaN の長さで全文を返してしまう（`next > NaN` が常に偽）。NaN は今までどおり本文を残さない。
  const kept = Number.isNaN(limit) ? "" : sliceAtGraphemeBoundary(trimmed, limit);
  return `${kept}…`;
}

/** {@link resolveDigest} の戻り値。 */
export interface ResolvedDigest {
  /** 使う digest（LLM の digest か、本文の先頭を切り出したもの）。 */
  digest: string;
  /** `digest` をどう作ったか（`"llm"` か `"fallback"`）。 */
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
 * LLM 呼び出し自体が失敗した場合の安全弁: Observation の全文をそのまま1件の `stated` Memory として残す。
 * **content（全文）は生成の成否に関わらず必ず書く**という規律（docs/memory-model.md §4）を、抽出全体が失敗した場合にも
 * 一貫させる（曖昧なら厚い側に倒す）。
 */
function fallbackWholeObservationCandidate(observation: Observation): ExtractedMemoryCandidate {
  return {
    content: observationPayloadText(observation),
    tags: [],
    provenanceKind: "stated",
  };
}

/**
 * 抽出がどう終わったか（ADR 0008 の「無い」の分類を、取り込み側にも適用する）。
 *
 * - `ok` — LLM が正常に応答した。**0件を返した場合も `ok`** である（何も記憶に値しないという判断は正常な抽出結果）。
 * - `llm_failed_whole_observation` — LLM 呼び出し自体が失敗し、Observation の全文を1件の Memory として残す安全弁へ
 *   倒れた（docs/memory-model.md §4「曖昧なら厚い側に倒す」）。**この Memory は「抽出された」ものではない。**未処理の
 *   生テキストである。1MBを超える本文は、本文自体は無傷で残るが、先頭150,000文字（`SQL_ASCII` の DB ではバイト）より後ろの
 *   語は語彙チャンネルからは引けない（{@link buildExtractionPrompt} の doc、ADR 0364）。
 * - `skipped` — この呼び出しでは抽出を実行していない（`deferred`、`memory_usage`、冪等な再送。`reextract` も、利用者の
 *   意思で退けた記憶を持つ Observation では `skipped` を返す。条件は `Runtime.reextract` の doc を参照）。
 */
export type ExtractionOutcome = "ok" | "llm_failed_whole_observation" | "skipped";

/**
 * `extractCandidates` が LLM 呼び出しの例外を飲んだとき、**中身だけは捨てずに運ぶ**ための形。
 *
 * 「例外を上へ伝播させない」こと自体は ADR 0013 の意図的な決定（安全弁）で維持するが、`llm_failed_whole_observation` という
 * 1つの値には少なくとも6種の原因（拒否 / 切り詰め / 空応答 / `ZodError` / `SyntaxError` / 通信・認証エラー）が畳まれる。
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
 * ⚠ **core は provider のクラスを知らない**（`packages/core/package.json` の `dependencies` は `zod` だけで、
 * `dependency-boundary.test.ts` が機械的に検査している）。`instanceof AnthropicLLMProviderError` のような判定はできず、
 * **値として `error.kind` を読む**（duck typing）。`kind` は `typeof === "string"` かつ空文字でないときだけ採り、
 * それ以外は `null` にする（「分からない」を勝手な種類に読み替えない）。
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

/** `extractCandidates` の戻り値。 */
export interface ExtractCandidatesResult {
  /** 記憶の候補。LLM の呼び出しが失敗したときは、観測の全文を本文にした候補1件（全文フォールバック）になる。 */
  candidates: ExtractedMemoryCandidate[];
  /** LLM 呼び出し自体が失敗し、全文フォールバックへ倒れたかどうか。 */
  usedWholeObservationFallback: boolean;
  /**
   * LLM 呼び出しが失敗した理由。**成功経路（0件を含む）は必ず `null`。**
   * 失敗経路（`usedWholeObservationFallback: true`）は必ず非 `null`。
   */
  failure: ExtractionFailure | null;
  /**
   * `subjectCandidates` が渡されたとき、LLM が返した `subjectId` のうち**一覧に無かった文字列**（弾く前の値、弾いた順）。
   * 弾いた候補は `candidates` の該当要素の `subjectId` から既に取り除かれている（`undefined`＝未指定へ戻り、
   * `buildNewMemoryFromCandidate` が observation の値へフォールバックする）。この欄は「黙って戻さない」ための記録専用で、
   * `candidates` の中身には影響しない。渡さなかった・空配列だった・何も弾かれなかったときは `[]`。
   *
   * 型としては optional。新しい**必須**プロパティを足すと、この型を自前で実装している外部コードがコンパイルできなくなる
   * 可能性があり、「新しい任意プロパティの追加」だけが semver 的に安全だから（[ADR 0178](../../../docs/decisions/0178-public-api-surface-gate.md)）。
   */
  rejectedSubjectIds?: string[];
}

/**
 * LLM が返した1候補の `subjectId` を、呼び出し側が渡した `subjectCandidates` に照らして検証する。
 *
 * - `subjectId` が `undefined`（省略）または `null`（明示的な「主題なし」）なら、一覧の有無に関わらず常に有効。
 *   `null` は「一覧のどれか」ではなく「主題を持たない」という別の値で、一覧に含まれている必要が無い。
 * - `allowedSubjectCandidates` が `undefined` または空配列なら、検証しようがないので常に有効（「空配列＝渡していないと同じ」
 *   規約）。`reextract`（候補一覧を持たない）はこの関数を通しても挙動が変わらない。
 * - **（ADR 0456）`subjectId` が識別子として保存できない値（NUL・孤立サロゲートを含む）なら、一覧の有無に関わらず弾く**
 *   （`undefined` を返し、`rejected: true`）。弾かないと保存の口が `MalformedIdentifierError` を投げて `observe` が
 *   例外で終わる。
 * - それ以外（一覧が渡されていて、`subjectId` が非 null 文字列）は、一覧に含まれるかを検査する。含まれていれば有効。
 *   **含まれていなければ弾き、`undefined`（未指定）を返す**（`buildNewMemoryFromCandidate` が `observation.subjectId` へ
 *   フォールバックする）。
 * - **例外: 一覧が渡されていて、`subjectId` が文字列 `"null"`（JSON の `null` リテラルではない）で、かつ一覧そのものに
 *   `"null"` という文字列が候補として含まれていないとき**は、弾かずに明示的な `null`（主題なし）として扱う。実 API
 *   （gpt-4o-mini）は「主題が無いなら明示的に null を設定してください」という指示に、JSON の `null` ではなく文字列 `"null"` を
 *   返した（[ADR 0304](../../../docs/decisions/0304-subject-candidates-string-null-literal.md)）。これを一覧外の値として弾くと、
 *   「主題なし」が実 API 上ついに再現できない。一覧に `"null"` という文字列自体が候補として含まれている場合は、この特例より前の
 *   「一覧内はそのまま」判定が先に真になるので、この特例は「一覧に無い `"null"`」だけを拾う。
 */
export function sanitizeCandidateSubjectId(
  subjectId: string | null | undefined,
  allowedSubjectCandidates: readonly string[] | undefined,
): { subjectId: string | null | undefined; rejected: boolean } {
  if (subjectId === undefined || subjectId === null) {
    return { subjectId, rejected: false };
  }
  // 識別子として保存できない値（NUL・孤立サロゲート）は、一覧の有無に関わらず弾く（ADR 0456）。
  if (findMalformedIdentifierPart(subjectId) !== null || /[^\x00-\x7f]/.test(subjectId)) {
    return { subjectId: undefined, rejected: true };
  }
  if (allowedSubjectCandidates === undefined || allowedSubjectCandidates.length === 0) {
    return { subjectId, rejected: false };
  }
  if (allowedSubjectCandidates.includes(subjectId)) {
    return { subjectId, rejected: false };
  }
  if (subjectId === "null") {
    return { subjectId: null, rejected: false };
  }
  return { subjectId: undefined, rejected: true };
}

/**
 * `extractCandidates` の成功経路が返す前に、LLM の生の応答（`result.memories`）へ `sanitizeCandidateSubjectId` を適用する。
 * `usedWholeObservationFallback: true` の経路はここを通らない（安全弁で作る候補は `subjectId` を持たない）。
 */
function sanitizeExtractionCandidates(
  candidates: ExtractedMemoryCandidate[],
  subjectCandidates: readonly string[] | undefined,
): { candidates: ExtractedMemoryCandidate[]; rejectedSubjectIds: string[] } {
  const rejectedSubjectIds: string[] = [];
  const sanitized = candidates.map((candidate) => {
    const result = sanitizeCandidateSubjectId(candidate.subjectId, subjectCandidates);
    if (result.rejected) {
      rejectedSubjectIds.push(candidate.subjectId as string);
    }
    // `rejected: false` でも `result.subjectId` が `candidate.subjectId` と異なることがある（文字列 `"null"` を明示的な `null` へ
    // 読み替える特例）。**常に `result.subjectId` を採用する**（`rejected` の真偽で分岐しない）。`candidate` をそのまま返すと、
    // この読み替えが反映されずに文字列 `"null"` が Memory まで素通りする。
    if (result.subjectId === candidate.subjectId) {
      return candidate;
    }
    return { ...candidate, subjectId: result.subjectId };
  });
  return { candidates: sanitized, rejectedSubjectIds };
}

/**
 * `LLMProvider.completeStructured` を呼び、失敗したら全文フォールバックへ倒す。
 *
 * **LLM が正常に「0件」を返した場合はフォールバックしない。**何も記憶に値しないという判断は正常な抽出結果で、これを
 * 「失敗」として無理に1件作ると、毎回渡す量を減らす方向に反するゴミ記憶を増やす。フォールバックの対象は **LLM 呼び出し
 * 自体が失敗した場合**（ネットワークエラー・タイムアウト・スキーマ不整合等）。**候補のどれか1件でも本文が空白だけなら、
 * それも失敗として扱う**（`""` がスキーマ不整合で全体を失敗にするのと同じ。`llm-content.ts` の doc 参照）。
 *
 * `subjectCandidates` を渡すと、`buildExtractionPrompt` の文面に候補一覧と null の指示が足され、LLM の応答は
 * `sanitizeExtractionCandidates` で検証された後に返る。省略・空配列なら、プロンプトも検証も変わらない。
 *
 * **`signal` を渡し、それが abort されたことによる例外は、全文フォールバックへ倒さず、そのまま投げ直す**
 * （[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。「中断した」と「LLM 呼び出しが本当に
 * 失敗した」を同じ顔にすると、呼び出し側が区別できない（全文フォールバックの記憶は作られず、
 * `usedWholeObservationFallback` にもならない）。
 */
export async function extractCandidates(
  llmProvider: LLMProvider,
  ctx: Ctx,
  observation: Observation,
  subjectCandidates?: readonly string[],
  signal?: AbortSignal,
): Promise<ExtractCandidatesResult> {
  try {
    const result = await runAbortable(signal, (raced) =>
      llmProvider.completeStructured(
        ctx,
        {
          prompt: buildExtractionPrompt(observation, subjectCandidates),
          schema: ExtractionResultSchema,
        },
        { signal: raced },
      ),
    );
    for (const memory of result.memories) {
      assertLLMContentNotBlank(memory.content, "extract");
    }
    const sanitized = sanitizeExtractionCandidates(result.memories, subjectCandidates);
    return {
      candidates: sanitized.candidates,
      usedWholeObservationFallback: false,
      failure: null,
      rejectedSubjectIds: sanitized.rejectedSubjectIds,
    };
  } catch (error) {
    if (isAbort(signal)) {
      throw error;
    }
    return {
      candidates: [fallbackWholeObservationCandidate(observation)],
      usedWholeObservationFallback: true,
      failure: describeExtractionFailure(error),
      rejectedSubjectIds: [],
    };
  }
}

/** {@link buildNewMemoryFromCandidate} の入力。 */
export interface BuildNewMemoryParams {
  /** `tenantId` を新しい Memory に使う。 */
  ctx: Ctx;
  /** 元になった Observation（`sourceObservationId`・主題・時刻・出所の元）。 */
  observation: Observation;
  /** 組み立てる記憶の候補。 */
  candidate: ExtractedMemoryCandidate;
  /** 本文から `contentHash` を作る関数（`RuntimeDeps.hashContent` と同じもの）。 */
  hashContent: (content: string) => string;
  /** 抽出器の版（`Memory.extractorVersion`。冪等キーの一部）。 */
  extractorVersion: string;
  /** 推論の出所に書くモデル名（`inferred` の `provenance.model`）。 */
  llmModelId: string;
  /** 推論の出所に書くプロンプトの版（`inferred` の `provenance.promptVersion`）。 */
  promptVersion: string;
  /** 新しい Memory の半減期（時間）。 */
  halfLifeHours: number;
  /** 新しい Memory の `recordedAt` にする時刻（減衰の起点にもなる）。 */
  now: Date;
  /** LLM の digest が無い・空のときに、本文の先頭から切り出す長さ。 */
  digestFallbackLength: number;
  /**
   * 書き込み時点の `tenant_activity.activity_seq`（テナントの `decay_clock` が `'wall'` 以外のときだけ呼び出し側が渡す。
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)）。`halfLifeRecalls` と対で渡すこと（片方だけ渡しても
   * 活動時計の3つ組は作られない）。
   */
  activitySeq?: number | undefined;
  /**
   * この Memory の活動時計での半減期（単位: recall 回数）。**`activitySeq` と両方揃っていないと、活動時計の3つ組
   * （`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）は作られない**。`'wall'` のテナントでは呼び出し側がどちらも渡さず、
   * 3つとも `undefined` のまま Memory に書かれる。
   */
  halfLifeRecalls?: number | undefined;
  /**
   * opt-in で取れた claim key（claim-key.ts の `ClaimKey` 参照）。`undefined`/`null` はどちらも「鍵なし」。
   */
  claimKey?: ClaimKey | null | undefined;
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
  // 活動時計の3つ組は、`activitySeq`/`halfLifeRecalls` の両方が揃っているときだけ作る（'wall' のテナントでは3つとも undefined）。
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
    // 候補の subjectId を優先し、`undefined`（省略・未指定）のときだけ observation の値へ落ちる。`null`（明示的な「主題なし」）は
    // observation の値があってもそのまま通す（上書きすると、主題なしを明示した候補が書けなくなる）。規則は `memory-subject.ts`。
    subjectId: resolveCandidateSubjectId(params.candidate, params.observation),
    sourceObservationId: params.observation.id,
    extractorVersion: params.extractorVersion,
    content: params.candidate.content,
    contentHash: params.hashContent(params.candidate.content),
    digest,
    digestSource,
    provenance: buildProvenance(params),
    tags: dropBlankTags(params.candidate.tags ?? []),
    occurredAt: params.observation.occurredAt ?? null,
    recordedAt: params.now,
    lastReinforcedAt: null,
    // `occurredAt` と同じ経路で `Observation` から素通しする。1回の `observe()` から複数候補が抽出されると、全候補が同じ区間を共有する。
    validFrom: params.observation.validFrom ?? null,
    validUntil: params.observation.validUntil ?? null,
    // 観測の attributes をそのまま継承する（全文フォールバック経路を含む）。限定の出所から出た記憶は限定のまま、落とす方向に倒す（ADR 0312）。
    attributes: params.observation.attributes ?? {},
    claimKey: params.claimKey ?? null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
    decayFloorAt,
    decayBaseSeq,
    decayFloorSeq,
    halfLifeRecalls: hasActivityInputs ? params.halfLifeRecalls : undefined,
    embeddingStatus: "pending",
  };
}
