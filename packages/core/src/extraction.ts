import { z } from "zod";
import { isAbort, runAbortable } from "./abort.js";
import type { ClaimKey } from "./claim-key.js";
import type { Ctx } from "./ctx.js";
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
import { sliceWithoutSplittingSurrogatePair } from "./text-truncation.js";

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
   *
   * ⚠ **`@mnemora/openai` では、明示の `null`（主題なし）が core に届かない**
   * （[Issue #1082](https://github.com/takecchi/mnemora/issues/1082)）。OpenAI の strict モードは
   * 「省略可能」を「必須かつ `null` 可」に翻訳するので、応答の `null` だけでは「未指定」と
   * 「主題なし」を区別できず、`OpenAILLMProvider.completeStructured` はすべての `null` を
   * キーごと消してから（`stripNulls`）このスキーマに渡す。⟹ モデルが指示どおり `null` を返しても
   * **省略（未指定）として届き、Memory は observation の主題を持つ**。`@mnemora/anthropic` は
   * `null` を保つので、主題なしの Memory になる。`subjectCandidates` を渡して「主題なし」を
   * 選ばせる使い方は、今は `@mnemora/anthropic`（か、`null` を保つ自前の provider）でだけ効く。
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
/** 抽出の LLM が返す記憶の候補1件（{@link ExtractedMemoryCandidateSchema} の型）。 */
export type ExtractedMemoryCandidate = z.infer<typeof ExtractedMemoryCandidateSchema>;

/** 抽出の LLM に返させる値の zod スキーマ（`memories` は候補の配列。0件もありうる）。 */
export const ExtractionResultSchema = z.object({
  memories: z.array(ExtractedMemoryCandidateSchema),
});
/** {@link ExtractionResultSchema} の型。 */
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// `observationPayloadText`（観測の本文の合成。Issue #1185 の doc を含む）は `observation-text.ts` へ移した（Issue #1370、ADR 0391。中身は同じ）。

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
 *
 * **Issue #1370（本文の言語・話者の取り違え）でも同じ規律を保つ**——この定数へは1バイトも
 * 足さず、`subjectCandidates` が渡されたときだけ {@link buildLanguageAndSpeakerInstruction}
 * を足す（`buildExtractionPrompt` 参照）。
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

/**
 * Issue #1370: `subjectCandidates` が渡されたときだけ足す、出力言語と話者取り違えの指示。
 *
 * ⚠ **`EXTRACTION_PROMPT_SYSTEM_BASE` 自体にも `extractionContext` 分岐にも足さない。**
 * `EXTRACTION_PROMPT_SYSTEM_BASE` を1バイトでも変えると、記録済みカセット
 * （`examples/chat/cassettes/`、約1,194件）の `llmCassetteKey`（`{system, messages}` の
 * sha256、ADR 0051）が全部動き、Issue #704 の評価用録音も録り直しが要る。`extractionContext`
 * 分岐の文面を変えると、`extraction-context*.test.ts` の録音再生テストが壊れる
 * （実測: 一文足しただけで51件が赤くなった）。⟹ **`subjectCandidates` を渡す呼び出し
 * （録音に無いことを grep で確認済み）にだけ足すことで、両方の鍵を動かさずに直す。**
 * デフォルト経路（`subjectCandidates` を渡さない呼び出し）へも同じ指示を広げるかは
 * オーナー判断待ち（CHANGELOG `[1.1.0]` 参照）。
 *
 * 話者の一文は、`extractionContext` も同時に渡したときにこの直後へ続く既存の一文
 * 「他の話者の発言を対象話者の事実として抽出しないでください」と**向きが逆で、補い合う**
 * ——既存の一文は「他の話者（`extractionContext` 側）の発言を、対象話者（`speaker`）の
 * 事実にしない」（他者→対象話者、の誤帰属を止める）のに対し、ここで足す一文は「対象話者
 * （`speaker`）自身の発言を、別の人物（利用者など）の発言・意見にしない」（対象話者→他者、
 * の誤帰属を止める）。**同じ「話者の取り違え」という1つの線の、両側をそれぞれ塞ぐ**もので、
 * 重複も矛盾もしない。
 */
function buildLanguageAndSpeakerInstruction(): string {
  return (
    "記憶の本文（content）と要旨（digest）は、観測の本文と同じ言語で書いてください" +
    "（subjectId や provenanceKind などの識別子はこの限りではありません）。" +
    "観測の発言の話者（本文の先頭の話者ラベル、または speaker）自身の発言は、" +
    "その話者についての記憶として扱い、別の人物（利用者など）の発言・意見として書かないでください。"
  );
}

/**
 * `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約はスキーマ側にある。
 *
 * ⚠ **観測の本文は切り詰めずに、そのまま入れる**（今の振る舞い。`observe()` の入力にも上限は無い）。
 * プロンプトの大きさは本文にほぼ比例する（2026-09-27 の実測: 約1MB の本文で、送るリクエストは
 * 約1.05MB。`@mnemora/anthropic` と `@mnemora/openai` で数バイトの差しかない）。`extractionContext` は
 * `ExtractionContextSchema` が件数と長さを抑えるので、足される量は約50KB までである。
 * 入力がモデルの上限を超えると、provider は API の拒否をそのまま投げ（分類の `kind` は付かない。
 * 各 provider の `errors.ts` 参照）、抽出は LLM の失敗として全文フォールバックへ倒れる
 * ——本文は1文字も落ちずに1件の Memory として残る。
 * ⚠ 2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1222](https://github.com/takecchi/mnemora/issues/1222)）:
 * **`@mnemora/postgres` では、語の多い本文（tsvector が 1MB を超えるもの）はこの Memory を書けない。**
 * `memories.content` は語彙の索引に入り、tsvector は 1048575 バイトを超えられない。そのため、`observe()` は
 * DB の例外（`string is too long for tsvector`）を投げる。Observation と extract ジョブは残り、Memory は1件も
 * 残らない。`tick()` での再試行も同じ所で失敗し、ジョブは `failed` になる。上限は本文の長さではなく tsvector の
 * 大きさで決まる（ランダムな16進の語では約0.9MB で落ち、空白の無い日本語の続き書きは 1.8MB でも通った）。
 * testkit の fixture は1件残す。
 * ⚠ 2026-09-29 追記（上の追記を反転させる。`packages/postgres/migrations/0025_lexical_tsvector_fallback.sql`、
 * `docs/decisions/0364-lexical-tsvector-fallback-for-oversized-content.md`）:
 * **`@mnemora/postgres` も直った。**`idx_memories_lexical` の式に、tsvector が1MBを超える本文だけ
 * 本文の先頭150,000文字（`SQL_ASCII` の DB ではバイト。ADR 0364 の 2026-09-30 の追記）で作り直すフォールバックを挟んだ（`mnemora_lexical_tsvector`）。**`@mnemora/postgres`
 * も testkit の fixture と同じく、本文は1文字も落ちずに1件の Memory として残る**——`memories.content` は
 * 無傷のまま全文を保存する。縮退するのは語彙**索引**だけで、150,000文字より後ろにしか現れない語は
 * `LexicalStore`（語彙チャンネル）からは引けない（ベクトル検索等、他の recall チャンネルには影響しない）。
 */
export function buildExtractionPrompt(
  observation: Observation,
  subjectCandidates?: readonly string[],
): PromptSpec {
  // Issue #608 項目②(b): 空配列は「渡していない」と同じ——`SubjectCandidatesInput` の
  // doc コメント（observation.ts）参照。ここで弾かないと、空配列を渡しただけで
  // `EXTRACTION_PROMPT_SYSTEM_BASE` と1バイトも違わない文面のはずが、空の一覧文言
  // （`候補一覧が渡されています: `）を余計に足してしまう。
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
  // Issue #1370（PR1）: 話者の一文（buildLanguageAndSpeakerInstruction）は「本文の先頭の話者ラベル、または
  // speaker」と言う。extractionContext が無いと user 入力は本文だけで payload.speaker が見えないので、
  // **候補あり・extractionContext 無し・speaker ありのときだけ**、本文の前に1行足す。
  // 候補なし（既定経路）と extractionContext 分岐（下。JSON の observation.speaker に既に出ている）は
  // 1バイトも変えない（カセット鍵・Issue #704 録音を動かさない）。
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
    const localDate =
      observation.occurredAt && context.timeZone
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: context.timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(observation.occurredAt)
        : null;
    const relativeDates =
      localDate === null
        ? null
        : Object.fromEntries(
            [
              ["昨日", -1],
              ["今日", 0],
              ["明日", 1],
              ["明後日", 2],
            ].map(([label, offset]) => [
              label,
              new Date(Date.parse(`${localDate}T00:00:00Z`) + Number(offset) * 86400000)
                .toISOString()
                .slice(0, 10),
            ]),
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
 */
export function truncateForFallbackDigest(content: string, maxLength: number): string {
  const trimmed = content.trim();
  // 負の上限は上限0（本文を残さない）として扱う。以前はここで負のまま比べていたので、本文が空のとき
  // だけ `maxLength: 0` と結果が分かれていた（0 なら "（内容なし）"、負なら "…"）。
  const limit = maxLength < 0 ? 0 : maxLength;
  if (trimmed.length <= limit) {
    return trimmed.length > 0 ? trimmed : "（内容なし）";
  }
  // `String.prototype.slice(0, n)` は n が負数だと「末尾から n 文字を除く」という
  // 別の意味になる（先頭からの切り詰めにならない）。maxLength は「安全弁」
  // （docs/memory-model.md §4）として本文の長さを抑える欄であり、負数は上限0
  // （本文を残さない）の下限として扱う。サロゲートペアの内側で切って孤立サロゲートを
  // 作らないための丸めも `sliceWithoutSplittingSurrogatePair` に集約してある
  // （`text-truncation.ts` の doc コメント参照）。
  return `${sliceWithoutSplittingSurrogatePair(trimmed, limit)}…`;
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
 *   ⚠ **2026-09-29 から `@mnemora/postgres` も、語の多い大きな本文でこの Memory を書ける**
 *   （`migrations/0025`・ADR 0364、Issue #1222。以前は DB の例外を投げていた——
 *   {@link buildExtractionPrompt} の doc の追記を見ること）。1MBを超える本文は、
 *   本文自体は無傷で残るが、先頭150,000文字（`SQL_ASCII` の DB ではバイト）より後ろの語は語彙チャンネルからは引けない。
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
 * - **例外: 一覧が渡されていて、`subjectId` が文字列 `"null"`（ダブルクォート付きの
 *   文字列であり JSON の `null` リテラルではない）で、かつ一覧そのものに `"null"` という
 *   文字列が候補として含まれていないとき**は、弾かずに明示的な `null`（主題なし）として
 *   扱う。【実測】gpt-4o-mini に実 API を当てたところ、`buildSubjectCandidateInstruction`
 *   の「主題が無いなら明示的に null を設定してください」という指示に対し、モデルは
 *   JSON の `null` ではなく文字列 `"null"` を5/5回返した（調査記録は
 *   `docs/decisions/0304-subject-candidates-string-null-literal.md`）。この文字列を
 *   そのまま「一覧外の値」として弾くと、Issue #608 の例2（「明日台風が来る 主題＝なし」）
 *   が実 API 上ついに一度も再現できない。**一覧に `"null"` という文字列自体が候補として
 *   含まれている場合はこの特例より前の「一覧内はそのまま」判定が先に真になるため、
 *   この特例は「一覧に無い `"null"`」だけを拾う。**
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
  if (subjectId === "null") {
    return { subjectId: null, rejected: false };
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
    if (result.rejected) {
      // `candidate.subjectId` はここでは非 null 文字列であることが確定している
      // （`sanitizeCandidateSubjectId` が `rejected: true` を返すのはその場合だけ）。
      rejectedSubjectIds.push(candidate.subjectId as string);
    }
    // ⚠ `rejected: false` でも `result.subjectId` が `candidate.subjectId` と異なることがある
    // ——文字列 `"null"` を明示的な `null` へ読み替える特例（上記 doc コメント）がその形。
    // **常に `result.subjectId` を採用する**（`rejected` の真偽で分岐しない）。以前は
    // `!result.rejected` のとき `candidate` をそのまま返しており、この読み替えが
    // 反映されずに文字列 `"null"` が Memory まで素通りしていた。
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
 * **LLM が正常に「0件」を返した場合はフォールバックしない。** 何も記憶に値しないという判断は
 * 正常な抽出結果であり、これを「失敗」として無理に1件作ると、北極星の物差し（毎回渡す量を
 * 減らす方向に働くか）に反するゴミ記憶を増やす。フォールバックの対象はあくまで
 * **LLM 呼び出し自体が失敗した場合**（ネットワークエラー・タイムアウト・スキーマ不整合等）。
 * **候補のどれか1件でも本文が空白だけなら、それも失敗として扱う**（`""` がスキーマ不整合で
 * 全体を失敗にするのと同じ。Issue #1065、`llm-content.ts` の doc 参照）。
 *
 * `subjectCandidates`（Issue #608 項目②(b)）を渡すと、`buildExtractionPrompt` の文面に
 * 候補一覧と null の指示が足され、LLM の応答は `sanitizeExtractionCandidates` で検証
 * された後に返る。省略・空配列なら、プロンプトも検証も従来どおり（1バイトも変わらない）。
 *
 * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）: `signal` を
 * 渡し、それが abort されたことによる例外は、全文フォールバックへ倒さず、そのまま投げ直す。**
 * 「中断した」と「LLM 呼び出しが本当に失敗した」を同じ顔にすると、呼び出し側が区別できない
 * ——全文フォールバックの記憶は作られない・`usedWholeObservationFallback` にもならない。
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
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3・5:
   * 書き込み時点の `tenant_activity.activity_seq`（テナントの `decay_clock` が
   * `'wall'` 以外のときだけ呼び出し側が渡す）。`halfLifeRecalls` と対で渡すこと——
   * 片方だけ渡しても活動時計の3つ組は作られない（下記 `halfLifeRecalls` 参照）。
   */
  activitySeq?: number | undefined;
  /**
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3:
   * この Memory の活動時計での半減期（単位: recall 回数）。**`activitySeq` と両方
   * 揃っていないと、活動時計の3つ組（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）は
   * 作られない**——`'wall'` のテナントでは呼び出し側がどちらも渡さず、3つとも
   * `undefined` のまま Memory に書かれる（ADR 0165 決めたこと5「`'wall'` のテナントでは
   * 何も増えない」）。
   */
  halfLifeRecalls?: number | undefined;
  /**
   * Issue #371（claim-key.ts の `ClaimKey` 参照）: opt-in で取れた claim key。
   * `undefined`/`null` はどちらも「鍵なし」——呼び出し側（`runtime.ts`）が claim key
   * opt-in を使っていない、またはこの候補について鍵が取れなかった場合。
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
    // 規則は `memory-subject.ts`（runtime.ts が活動時計の「いま」を解くときも同じ関数を使う。ADR 0394）。
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
    // Issue #280: `occurredAt` と同じ経路で `Observation` から素通しする
    // （`Observation.validFrom`/`validUntil` の doc コメント参照）。1回の `observe()`
    // から複数候補が抽出されると、全候補が同じ区間を共有する（`occurredAt` と同型の限界）。
    validFrom: params.observation.validFrom ?? null,
    validUntil: params.observation.validUntil ?? null,
    // Issue #152（ADR 0312）: 観測の attributes をそのまま継承する（フォールバック経路
    // `fallbackWholeObservationCandidate` を含め、この関数を通る全候補が対象）。
    // 「限定の出所から出た記憶は限定のまま」——落とす方向に倒す（`Memory.attributes` の
    // doc コメント参照）。
    attributes: params.observation.attributes ?? {},
    // Issue #371: opt-in で取れた claim key をそのまま通す。`undefined`/`null` は
    // どちらも「鍵なし」——`params.claimKey` の doc コメント（`BuildNewMemoryParams`）参照。
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
