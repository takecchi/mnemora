import { z } from "zod";
import { AttributesSchema, StoredAttributesSchema } from "./attributes.js";
import type { Attributes } from "./attributes.js";
import { ClaimKeyOptionsSchema, type ClaimKeyOptions } from "./claim-key.js";
import type { ObservationId } from "./ids.js";

/**
 * mnemora の外で起きたことの生の記録（docs/memory-model.md §1・§10）。
 *
 * `kind` はあえて閉じたユニオンにしない（DB 側も CHECK 制約を付けない）。新しい観測の種類を追加するたびに
 * マイグレーションを要求しないため。開いているものは開いていると分かる形にする規約（memory-model.md §10）を
 * 型にも反映し、`kind: string` とする。
 */
export interface Observation {
  /** Observation の id。 */
  id: ObservationId;
  /** Observation が属するテナント。 */
  tenantId: string;
  /** 主題。主題の無い観測は `null`（または省略）。 */
  subjectId?: string | null;
  /** 呼び出し側の id（テナント内で一意。任意）。同じ値で再送すると、同じ Observation を返す（docs/architecture.md §3.5）。 */
  externalId?: string | null;
  /** 観測の種類（`utterance`・`event`・`document`・`usage` など。開いた文字列。上の doc）。 */
  kind: string;
  /**
   * 観測の中身。形は `kind` で決まる（`utterance` は `{ text, speaker }`、`event` は `{ name, data }`、`document` は `{ title, content }`、`usage` は `{ recallId, usedMemoryIds }`。`extractionContext` を渡したときはそれも入る）。
   */
  payload: unknown;
  /**
   * その出来事・事実がいつのものか（`docs/memory-model.md` §3「三つ（四つ）の時計」）。
   *
   * **呼び出し側の申告をそのまま受け入れる。未来の値も拒まない**（ADR 0037、ADR 0036）。
   * 「来月、京都へ出張する」のような予定はふつうに未来になる。**未来の `occurredAt` が「まだ起きていない予定」なのか
   * 「呼び出し側の時計がずれている」なのかは区別せず**、極端に未来の値を警告・拒否する検証も、信頼度・出所を示す
   * 別欄も無い（この区別をしないことを仕様として記録した。ADR 0037 追記）。
   *
   * ⚠ **表せる日時の範囲は adapter によって違う**。
   * schema は `Date` であることしか検査しない（JS の `Date` は ±275760年まで）。
   * `@mnemora/postgres` の `timestamptz` は `new Date("-004713-11-24T00:00:00.000Z")`
   * （先発グレゴリオ暦の紀元前4714年11月24日、UTC）より前を表せず、この欄・`validFrom`・
   * `validUntil` にそれより前の日時を渡すと書き込みが例外（`timestamp out of range`）になり、
   * `observe()` は reject する。上側は Postgres のほうが広い（西暦294276年まで）ので分かれない。
   * `@mnemora/testkit` の fixture は、この欄に下限より前の日時を渡されると、書き込みの前に
   * `RangeError`（`<口>: <欄> must not be earlier than 4714-11-24 BC …`）で断り、何も書かない
   * （ADR 0640）。下限ちょうどは通り、同じ値で返す。
   * `opts.now`・`opts.at` も同じく断る（ADR 0500）。読みの口の日時の条件は、Postgres が下限へ寄せて比べるので
   * 断らない（ADR 0547）。
   * **保証するのは、上の日時以降の値だけである。**
   */
  occurredAt?: Date | null;
  /** 記録した時刻。 */
  recordedAt: Date;
  /**
   * `ObserveXxxInput.validFrom`/`validUntil`（下記）を `occurredAt` と**同じ経路**で運ぶための、`Observation` 側の置き場。
   *
   * `extract: 'deferred'` では、抽出は後から `processExtractJob` が拾い、そこでは `getObservation` で DB から
   * 読み直した `Observation` しか手元に無い（元の `ObserveXxxInput` は捨てられている）。`validFrom`/`validUntil` を
   * `Observation` に持たせず sync 経路だけの一時変数として流すと、deferred 経路では値が消える。`occurredAt` が同じ
   * 理由で永続フィールドになっているのと対称の判断。
   *
   * 表せる日時の範囲は `occurredAt` と同じく adapter によって違う（`occurredAt` の doc）。
   *
   * ⚠ **`validFrom` が `validUntil` より後の区間（逆転した区間）も拒まない。**`observe()` の schema も
   * `MemoryStore` も、2つの端の順序を検査しない。そうした Memory は `recall()` の `validAt`
   * ゲート（ADR 0164）を、どの時点でも通らない——`validAt` が2つの端の間
   * （`validUntil <= validAt < validFrom`）なら `omitted` の `filtered(expired)` と
   * `filtered(not_yet_valid)` の**両方に1件ずつ**数えられ、それ以外の時点ではどちらか一方に
   * 数えられる（`@mnemora/postgres` と `@mnemora/testkit` の fixture で同じ）。`filtered` の件数は
   * 「その条件に当たる記憶の件数」であり、条件どうしが排他である約束は無い（ADR 0203）
   * ので、二重計上ではない。
   */
  validFrom?: Date | null;
  /** `validFrom` の doc 参照。対になる終点。 */
  validUntil?: Date | null;
  /**
   * 呼び手が申告した任意属性（ADR 0312）を `occurredAt`/`validFrom` と同じ経路
   * （`ObserveXxxInput.attributes` → `Observation.attributes` → `buildNewMemoryFromCandidate`）で運ぶための永続列。
   * 永続列にする理由は `validFrom` の doc と同じ（`extract: 'deferred'` では `getObservation` で読み直した `Observation`
   * しか手元に無い）。
   *
   * **型としては省略可能だが、runtime（`handleExtractableObservation`）は常に `{}` 以上の値を書く**
   * （ADR 0289）。`undefined` は、この欄を足す前に作られた行か、この型を自前で組み立てた呼び出し元だけが持ちうる。
   */
  attributes?: Attributes;
}

/** `MemoryStore.createObservation` などに渡す新しい Observation。`id` は store が付け、`recordedAt` は省略できる。 */
export type NewObservation = Omit<Observation, "id" | "recordedAt"> & {
  recordedAt?: Date | undefined;
};

/** `Observation` の zod スキーマ。値を実行時に検査するときに使う（型 `Observation` と揃えてある）。 */
export const ObservationSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),
  externalId: z.string().min(1).nullable().optional(),
  kind: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.date().nullable().optional(),
  recordedAt: z.date(),
  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),
  // 格納側は検査をしない schema を使う（`AttributesSchema` は入力側専用）。
  attributes: StoredAttributesSchema.optional(),
}) satisfies z.ZodType<Observation>;

/** `NewObservation` の zod スキーマ。値を実行時に検査するときに使う（型 `NewObservation` と揃えてある）。 */
export const NewObservationSchema = ObservationSchema.omit({
  id: true,
  recordedAt: true,
}).extend({
  recordedAt: z.date().optional(),
}) satisfies z.ZodType<NewObservation>;

/**
 * 抽出の既定モード。`sync` が既定。`deferred` を選んだ場合、抽出は `outbox` 経由の Scheduler を通る
 * （docs/architecture.md §3.3・§3.4）。
 */
export type ExtractMode = "sync" | "deferred";

/** `ExtractMode` の zod スキーマ。値を実行時に検査するときに使う（型 `ExtractMode` と揃えてある）。 */
export const ExtractModeSchema = z.enum(["sync", "deferred"]) satisfies z.ZodType<ExtractMode>;

/**
 * `runtime.observe` が投げるエラーの接頭辞。
 *
 * `extract: 'deferred'` と `subjectCandidates`（{@link SubjectCandidatesInput}）は同時に渡せない。`subjectCandidates` は
 * どこにも永続化されないので、deferred 抽出は渡された候補一覧を構造的に見られない。「渡されたのに黙って落とす」と
 * 呼び出し側は候補一覧が効いたと思い込むので、検証の段（DB へ何も書く前）で明示的に例外にする
 * （`LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX` と同じ「黙って無視しない」規律）。
 */
export const SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX =
  "runtime.observe: subjectCandidates is not supported with extract: 'deferred' (subjectCandidates is never persisted, so deferred extraction cannot see it): ";

/**
 * `claimKey`（{@link ClaimKeyOptions}）と `extract: 'deferred'` は同時に渡せない。理由は `subjectCandidates` と同じで、
 * `claimKey` オプションはどこにも永続化されず、`processExtractJob` はこの口を構造的に見られない。
 * 「渡されたのに黙って落とす」と、呼び出し側は claim key が取れたと思い込む。
 */
export const CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX =
  "runtime.observe: claimKey is not supported with extract: 'deferred' (claimKey is never persisted, so deferred extraction cannot see it): ";

/** `observe()` の入力ユニオンの判別子（DB 上は `kind = 'usage'` に対応する点に注意）。 */
export type ObserveInputKind = "utterance" | "event" | "memory_usage" | "document";

/**
 * `validFrom`/`validUntil` を呼び出し側から渡す口。`occurredAt` と同じ扱いで、**抽出（LLM）に推測させない**（ADR 0037）。
 *
 * ⚠ **粒度の限界**: この2欄は observation 単位のスカラーである。1回の `observe()` から複数の Memory 候補が
 * 抽出されると、**全候補が同じ `validFrom`/`validUntil` を共有する**（`occurredAt` が既に抱えている限界と同型。ADR 0037）。
 */
/**
 * 呼び出し側が既存の subject 台帳から候補一覧を渡し、抽出器（LLM）にその中から選ばせる口。
 * **mnemora は subject の台帳を持たない**（docs/architecture.md §3.7）ので、台帳は呼び出し側が持ち、
 * ここには「今回の observe() に関係しそうな候補」だけを渡す。
 *
 * ⚠ **`@mnemora/openai` では「主題なし」（`subjectId: null`）を選ばせられない。**モデルが `null` を返しても
 * 省略として届き、observation の `subjectId` へ落ちる（`ExtractedMemoryCandidateSchema.subjectId` の doc）。
 * 一覧の中から選ばせる部分はどの provider でも効く。
 *
 * - **渡す（要素は1件以上）**: `buildExtractionPrompt`（extraction.ts）が候補一覧と「候補の中から選べ。無ければ
 *   `subjectId: null` を明示せよ」という指示をプロンプトへ足す。抽出後、runtime は各候補の `subjectId` がこの一覧に
 *   含まれるかを検証する（`null` は一覧に無くても常に有効。「主題なし」は「一覧のどれか」とは別の値）。一覧に無い
 *   文字列が返ってきたら、その値を弾いて `undefined`（未指定）へ戻し、observation の `subjectId` へフォールバックする。
 * - **渡さない（省略・`undefined`）**: `buildExtractionPrompt` の文面は変わらない（カセットの鍵が動かない）。
 *   ⚠ **このとき runtime は LLM が返す `subjectId` を既定で捨て、observation の `subjectId` へ落とす**（ADR 0635）。
 *   `RuntimeConfig.acceptLlmSubjectIdWithoutCandidates: true` のときだけ、次が当てはまる。
 *   ⚠ **LLM が返す `subjectId` は、一覧に照らす検証をされず、そのまま Memory の主題になる**（opt-in のとき。
 *   NUL・孤立サロゲートを含む値だけは、一覧の有無に関わらず弾く。ADR 0456）。観察文の注入で同じテナントの別の
 *   subject に記憶を書かせられ、claim key の検出を併用すると、その subject の既存の記憶が `contested` になりうる
 *   （`ExtractedMemoryCandidateSchema.subjectId` の doc、ADR 0442）。`extract: 'deferred'` の `tick` と `reextract` は
 *   一覧を持てないので、opt-in のときは常にこの扱いになる。
 * - **空配列（`[]`）**: **「渡していない」と同じ**に扱う。検証しようのない空の一覧で、LLM が返す `subjectId` を
 *   常に無効化する極端な挙動に倒れるのを避けるため（`extraction.ts` の `sanitizeCandidateSubjectId`）。
 *
 * ⚠ **`reextract` はこの欄を使わない。**`Observation` にも `observations` テーブルにも持たせていない
 * （`extractObservationPayload`（runtime.ts）は種類ごとに固定欄だけをペイロードへ書き出す）。新しい DB 列や
 * マイグレーションを増やさずに済ませるための、意図的な非対称である。
 *
 * ⛔ **`extract: 'deferred'` と同時に渡すとエラーになる**（`SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX`）。
 */
export type SubjectCandidatesInput = string[];

/**
 * Bounded, caller-selected context for extraction. Persisted with the observation.
 * An empty object opts into metadata-aware extraction without preceding messages.
 * Context is evidence for resolving references, not additional observations to extract.
 *
 * ⚠ **`timeZone` の検査が問うのは「`Intl.DateTimeFormat` が受け付けるか」だけである。**
 * エラーの文面は「Invalid IANA time zone」だが、IANA の名前（`Asia/Tokyo`）でない値も受け付ける——UTC からの差の書き方
 * （`+09:00`・`-05:30`・`+0900`・`+09`）、略称（`JST`・`EST`）、大文字小文字の違う名前（`asia/tokyo`）。拒むのは
 * `Intl.DateTimeFormat` が拒む値（`GMT+9`・`Not/AZone`・空文字など）だけで、受け付ける値の集合は実行環境の `Intl`（ICU）に
 * 依存する。**値は正規化せず、渡された文字列のまま保存され、抽出のプロンプトにもそのまま入る**（`EST` を `Intl` は
 * `America/Panama` と解決するが、保存されるのは `EST` のまま）。観測日時の暦日（`observedLocalDate`）は、渡された値を
 * `Intl.DateTimeFormat` に渡して計算する。検査を IANA の名前だけに絞ると、通っている入力が例外になる（破壊的）ので締めていない。
 *
 * ⚠ **`messages[].text` の `max(2000)`（`speaker` の `max(200)` も同じ）が数える単位は Unicode のコードポイントである**
 * （UTF-16 のコード単位でも、書記素でも、バイトでもない）。`😀`（コード単位2つ）を2000個は通り2001個は断る。
 * 結合文字つきの `e\u0301`（2コードポイント・1書記素）は1000個で通り1001個で断り、ZWJ 絵文字 `👨‍👩‍👧`（5コードポイント・
 * 1書記素）は400個で通り401個で断る。孤立サロゲートも1つを1コードポイントと数える。
 */
export const ExtractionContextSchema = z.object({
  messages: z
    .array(
      z.object({
        text: z.string().min(1).max(2000),
        speaker: z.string().min(1).max(200).optional(),
      }),
    )
    .max(8)
    .optional(),
  timeZone: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA time zone")
    .optional(),
});
/** 抽出に添える文脈（直前の会話・タイムゾーン）。Observation に一緒に保存される。形と上限は {@link ExtractionContextSchema}。 */
export type ExtractionContext = z.infer<typeof ExtractionContextSchema>;

/** `observe` に渡す発話。 */
export interface ObserveUtteranceInput {
  /** 抽出に添える文脈（直前の会話・タイムゾーン）。Observation に一緒に保存される。形と上限は {@link ExtractionContextSchema}。 */
  extractionContext?: ExtractionContext | undefined;
  /** 常に `"utterance"`。 */
  kind: "utterance";
  /** この観測の主題。`ctx.subjectId` より優先する（どちらも無ければ主題の無い観測になる）。 */
  subjectId?: string | undefined;
  /** 長さの上限は約束しない——`Ctx`（`ctx.ts`）の doc 参照。 */
  externalId?: string | undefined;
  /** {@link Observation.occurredAt} の doc 参照（未来の値も拒まない。予定か時計ずれかは区別しない。ADR 0037）。 */
  occurredAt?: Date | undefined;
  /** {@link Observation.validFrom} の doc 参照（逆転した区間も拒まない）。 */
  validFrom?: Date | undefined;
  /** 有効期間の終わり（{@link Observation.validFrom} の doc 参照）。 */
  validUntil?: Date | undefined;
  /** 抽出の実行のしかた（{@link ExtractMode}）。省略なら `"sync"`（`observe` の中で抽出する）。`"deferred"` は outbox に積み、`tick` で抽出する。 */
  extract?: ExtractMode | undefined;
  /** {@link SubjectCandidatesInput} の doc 参照。 */
  subjectCandidates?: SubjectCandidatesInput | undefined;
  /** {@link Observation.attributes} の doc 参照（ADR 0312）。 */
  attributes?: Attributes | undefined;
  /** {@link ClaimKeyOptions} の doc 参照。既定は無効——省略すると `deriveClaimKeys` は一度も呼ばれない。 */
  claimKey?: ClaimKeyOptions | undefined;
  /** 話者（例: `"user"`）。抽出に渡し、`stated` の Memory の出所にも残る。 */
  speaker?: string | undefined;
  /** 発話の本文。抽出（LLM）に渡し、LLM が失敗したときの全文フォールバックの Memory の本文にもなる。⚠ 空文字と、`trim` で空になる値（空白・改行・タブ・U+3000 だけ）は `ZodError`（ADR 0502）。 */
  text: string;
}

/** `observe` に渡す出来事。⚠ 抽出に渡るのは既定では `name` だけである（`data` の doc、`extractData` で opt-in できる）。 */
export interface ObserveEventInput {
  /** 抽出に添える文脈（直前の会話・タイムゾーン）。Observation に一緒に保存される。形と上限は {@link ExtractionContextSchema}。 */
  extractionContext?: ExtractionContext | undefined;
  /** 常に `"event"`。 */
  kind: "event";
  /** この観測の主題。`ctx.subjectId` より優先する（どちらも無ければ主題の無い観測になる）。 */
  subjectId?: string | undefined;
  /** 長さの上限は約束しない——`Ctx`（`ctx.ts`）の doc 参照。 */
  externalId?: string | undefined;
  /** {@link Observation.occurredAt} の doc 参照（未来の値も拒まない。予定か時計ずれかは区別しない。ADR 0037）。 */
  occurredAt?: Date | undefined;
  /** {@link Observation.validFrom} の doc 参照（逆転した区間も拒まない）。 */
  validFrom?: Date | undefined;
  /** 有効期間の終わり（{@link Observation.validFrom} の doc 参照）。 */
  validUntil?: Date | undefined;
  /** 抽出の実行のしかた（{@link ExtractMode}）。省略なら `"sync"`（`observe` の中で抽出する）。`"deferred"` は outbox に積み、`tick` で抽出する。 */
  extract?: ExtractMode | undefined;
  /** {@link SubjectCandidatesInput} の doc 参照。 */
  subjectCandidates?: SubjectCandidatesInput | undefined;
  /** {@link Observation.attributes} の doc 参照（ADR 0312）。 */
  attributes?: Attributes | undefined;
  /** {@link ClaimKeyOptions} の doc 参照。既定は無効——省略すると `deriveClaimKeys` は一度も呼ばれない。 */
  claimKey?: ClaimKeyOptions | undefined;
  /**
   * 出来事の名前。**`extractData`（下記）を渡さない既定の呼び出しでは、抽出（LLM）に渡すのはこの欄だけである**
   * （下の `data` の doc 参照）。LLM 呼び出しが失敗したときの全文フォールバックの Memory も、既定ではこの欄の
   * 文字列だけを本文にする。
   * ⚠ 空文字と、`trim` で空になる値（空白・改行・タブ・U+3000 だけ）は `ZodError`（ADR 0502）。
   */
  name: string;
  /**
   * ⚠ **既定ではこの欄は抽出（LLM）に渡らない。**抽出のプロンプトと全文フォールバックの Memory の本文は `name` だけで、
   * `data` は Observation の `payload` に保存されるだけである。
   *
   * **`extractData: true` を渡すと opt-in できる**（下記）。抽出のプロンプトと LLM 失敗時の全文フォールバックの本文の
   * 両方に、`data` がキーを1つ以上持つオブジェクトのときだけ `${name}\n\n${JSON.stringify(data)}` の形で入る
   * （`data` を渡さない・空オブジェクト `{}` のときは、`extractData: true` でも `name` だけになる）。
   *
   * 出来事に付けるデータ。**JSON として保存される前提の欄である。**
   *
   * 値の型は検査しない。**保証するのは、JSON の値（有限の数・文字列・真偽値・`null`・配列・
   * プレーンなオブジェクト）が同じ値で読み戻ることだけである。**JSON で往復しない値は adapter に
   * よって違う:
   *
   * | 値 | `@mnemora/postgres`（`JSON.stringify` して `jsonb` に保存） | `@mnemora/testkit` の fixture |
   * |---|---|---|
   * | `NaN`・`Infinity`・`-Infinity` | `null` に変わる | そのまま保持する |
   * | `-0` | `0` に変わる | そのまま保持する |
   * | `Date` | ISO 8601 の文字列に変わる | `Date` のまま保持する |
   * | 値が `undefined` の欄 | 欄ごと消える | 欄が残る |
   * | `BigInt` | 例外（`JSON.stringify` が投げる） | 同じ |
   * | 関数・`Symbol` の値（欄の値として） | 欄ごと消える（配列の要素なら `null`） | 同じ（ADR 0486） |
   * | `toJSON` を持つ値 | `toJSON` の戻り値で保存する（`data` 自体が `toJSON` を持てば、`1` のような object でない値で読み戻る） | 同じ（ADR 0486。`toJSON` には欄の名前を渡す。`Date` は `toJSON` を呼ばず `Date` のまま保つ） |
   *
   * どちらも例外にならない値では、書き込みは成功する。その後の `getObservation`・
   * `reextract`・監査の読み返しは、adapter によって違う値を見る。**`extractData: true` の
   * プロンプトへ入るのは、この JSON 往復を経た後の `data`（`extractObservationPayload` が
   * `payload` へ書いた値）である**——adapter によって `JSON.stringify(data)` の中身が変わりうる
   * （値が `undefined` の欄だけの `data` は、Postgres では欄が消えて本文が `name` だけになり、
   * fixture では欄が残って `name` の後に `{}` が続く）。
   */
  data?: Record<string, unknown> | undefined;
  /**
   * `data` を抽出（LLM）に渡すかどうかの opt-in。**既定は `false`（渡さない）。**`true` のときだけ、Observation の
   * `payload` に `extractData: true` という印が保存される（`false`・省略のときは `payload` にこの欄自体が増えない）。
   *
   * この印は永続化されるため、`extract: 'deferred'`・`reextract` のどちらでも同じ形で再現される。
   * `subjectCandidates`/`claimKey`（deferred と同時に使えない）とは異なり、`extractData` は deferred と同時に
   * 指定しても例外にならない。上限は無い（詳細は [ADR 0369](../../../docs/decisions/0369-opt-in-extract-event-data-and-document-title.md)）。
   */
  extractData?: boolean | undefined;
}

/** `observe` に渡す文書。⚠ 抽出に渡るのは既定では `content` だけである（`title` の doc、`extractTitle` で opt-in できる）。 */
export interface ObserveDocumentInput {
  /** 抽出に添える文脈（直前の会話・タイムゾーン）。Observation に一緒に保存される。形と上限は {@link ExtractionContextSchema}。 */
  extractionContext?: ExtractionContext | undefined;
  /** 常に `"document"`。 */
  kind: "document";
  /** この観測の主題。`ctx.subjectId` より優先する（どちらも無ければ主題の無い観測になる）。 */
  subjectId?: string | undefined;
  /** 長さの上限は約束しない——`Ctx`（`ctx.ts`）の doc 参照。 */
  externalId?: string | undefined;
  /** {@link Observation.occurredAt} の doc 参照（未来の値も拒まない。予定か時計ずれかは区別しない。ADR 0037）。 */
  occurredAt?: Date | undefined;
  /** {@link Observation.validFrom} の doc 参照（逆転した区間も拒まない）。 */
  validFrom?: Date | undefined;
  /** 有効期間の終わり（{@link Observation.validFrom} の doc 参照）。 */
  validUntil?: Date | undefined;
  /** 抽出の実行のしかた（{@link ExtractMode}）。省略なら `"sync"`（`observe` の中で抽出する）。`"deferred"` は outbox に積み、`tick` で抽出する。 */
  extract?: ExtractMode | undefined;
  /** {@link SubjectCandidatesInput} の doc 参照。 */
  subjectCandidates?: SubjectCandidatesInput | undefined;
  /** {@link Observation.attributes} の doc 参照（ADR 0312）。 */
  attributes?: Attributes | undefined;
  /** {@link ClaimKeyOptions} の doc 参照。既定は無効——省略すると `deriveClaimKeys` は一度も呼ばれない。 */
  claimKey?: ClaimKeyOptions | undefined;
  /**
   * ⚠ **既定ではこの欄は抽出（LLM）に渡らない。**既定では抽出のプロンプトと全文フォールバックの Memory の本文は
   * `content` だけで作り、`title` は Observation の `payload` に保存されるだけである。
   *
   * **`extractTitle: true` を渡すと opt-in できる**（下記）。抽出のプロンプトと LLM 失敗時の全文フォールバックの
   * 本文の両方に、`title` が空でない文字列のときだけ `${title}\n\n${content}` の形で入る（`trim` で空になる値は
   * 空とみなして前置きにせず、断らず無視する。ADR 0517）。`title` を渡さない・空文字・空白だけのときは
   * `extractTitle: true` でも既定と同じ（`content` だけ）になる。**例外**: `extractTitle: true` かつ `content` が空文字
   * （`observe()` の入力では `content` が空文字も空白だけの値も拒まれる（ADR 0502）ため、`reextract` が読み直す既存
   * データ等でしか起こらない）で `title` が空でないときは、`title` だけを本文にする（末尾の区切りが浮かないよう）。
   */
  title?: string | undefined;
  /** 抽出（LLM）に渡す本文。既定ではこの欄だけを本文にする（全文フォールバックの Memory も同じ）。⚠ 空文字と、`trim` で空になる値（空白・改行・タブ・U+3000 だけ）は `ZodError`（ADR 0502）。 */
  content: string;
  /**
   * `title` を抽出（LLM）に渡すかどうかの opt-in。**既定は `false`（渡さない）。**`true` のときだけ、Observation の
   * `payload` に `extractTitle: true` という印が保存される（`false`・省略のときは `payload` にこの欄自体が増えない）。
   *
   * この印は永続化されるため、`extract: 'deferred'`・`reextract` のどちらでも同じ形で再現される。
   * `subjectCandidates`/`claimKey`（deferred と同時に使えない）とは異なり、`extractTitle` は deferred と同時に
   * 指定しても例外にならない。上限は無い（詳細は [ADR 0369](../../../docs/decisions/0369-opt-in-extract-event-data-and-document-title.md)）。
   */
  extractTitle?: boolean | undefined;
}

/**
 * 使用報告（ADR 0009）。抽出器を通らないため `extract` を持たない。
 * `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })`
 * という ADR 0009 の呼び出し形そのままの形にする。
 */
export interface ObserveMemoryUsageInput {
  /** 常に `"memory_usage"`（保存される Observation の `kind` は `"usage"`）。 */
  kind: "memory_usage";
  /**
   * 他3種（utterance/event/document）の `externalId` と同じ規約——テナント内一意・任意、再送は同じ Observation を
   * 返す（docs/architecture.md §3.5）。`observations` 行の冪等キーを補う（`recall_usages`/`reinforce` 自体は
   * `(recall_id, memory_id)` 主キーで元から冪等）。
   *
   * **再送時の設計**（`handleMemoryUsage` の doc 参照）: `recordUsage`/`reinforce` は保存済みの Observation の payload で
   * 呼ぶ（同じ externalId で違う payload が来た場合、後着は無視される——他 kind の再送と同じ規約）。返ってきた
   * Observation の `kind` が `usage` 以外（別 kind の externalId と衝突）なら、`recordUsage`/`reinforce` を呼ばず、
   * 他 kind の冪等な再送と同じ形（`memoryIds: []`、`extraction: 'skipped'`）で返す。
   */
  externalId?: string | undefined;
  /** 使った記憶を返した `recall()` の `recallId`。 */
  recallId: string;
  /**
   * その recall で実際に使った記憶の id。**この報告が、強化（`reinforce`）のきっかけになる**
   * （`docs/memory-model.md` §6「実際に使われたものだけを強化する」——強化のきっかけは
   * 「使われたと報告されたこと」である）。
   *
   * ⚠ **mnemora はこの一覧を、その recall が返した集合とも `ctx.subjectId` とも突き合わせない。**`recallId` の recall が返して
   * いない記憶や、別の subject の記憶（subject なしの記憶を含む）を渡しても、同じテナントに
   * 在れば `recall_usages` に記録されて強化される（`lastReinforcedAt`・`decayFloorAt` が進む）。
   * `@mnemora/postgres` と `@mnemora/testkit` の fixture で同じである。ほかのテナントの id は、
   * 強化の段で「memory not found」になる。
   * ⟹ **「その recall が返した記憶のうち、実際に使ったもの」だけを渡すのは呼び出し側の責務である**
   * ——`recall()` の `memories` から選ぶこと。subject を跨いだ報告も拒まない
   * （`docs/vision.md`「Subject は整理の単位。跨いでも事故ではない」）。
   */
  usedMemoryIds: string[];
}

/**
 * `runtime.observe()` への入力。
 *
 * ⚠ **入力の未知のキーは、例外にも警告にもならず黙って捨てられる**（`ObserveInputSchema` は `.strict()` ではない）。
 * 主題は、この入力の `subjectId`（`memory_usage` 以外）か `ctx.subjectId` に置く（両方あれば入力の
 * `subjectId` が勝つ）。`subject`・`subjectID` のような綴り違いは捨てられ、主題はそれが無いものとして
 * 決まる。TypeScript の余剰プロパティ検査が止めるのは、オブジェクトリテラルを直接渡したときだけである。
 */
export type ObserveInput =
  ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput | ObserveMemoryUsageInput;

/**
 * {@link SubjectCandidatesInput} の zod 表現。要素は `z.string().min(1)`（他の subject 系文字列欄と同じ規約）。
 * 配列自体は空でもよい（空配列は「渡していない」と同じに扱われるので、zod の時点では弾かない）。
 */
const SubjectCandidatesInputSchema = z.array(z.string().min(1)).optional();

/**
 * 本文になる欄（`utterance.text`・`event.name`・`document.content`）の検査。`min(1)` に加えて、
 * `String.prototype.trim` で空になる値（空白・改行・タブ・U+3000 など、JS の `trim` が落とす文字だけの値）を
 * 断る（ADR 0502）。エラーの `path`・`message` は `min(1)` が空文字に返すものに合わせる。
 * 前後や内側に空白のある普通の文は通す。他の `min(1)` 欄（`speaker`・`title` など）は対象外。
 */
const NonBlankTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Too small: expected string to have >=1 characters",
  });

const ObserveUtteranceInputSchema = z.object({
  extractionContext: ExtractionContextSchema.optional(),
  kind: z.literal("utterance"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  subjectCandidates: SubjectCandidatesInputSchema,
  attributes: AttributesSchema.optional(),
  claimKey: ClaimKeyOptionsSchema.optional(),
  speaker: z.string().min(1).optional(),
  text: NonBlankTextSchema,
}) satisfies z.ZodType<ObserveUtteranceInput>;

const ObserveEventInputSchema = z.object({
  extractionContext: ExtractionContextSchema.optional(),
  kind: z.literal("event"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  subjectCandidates: SubjectCandidatesInputSchema,
  attributes: AttributesSchema.optional(),
  claimKey: ClaimKeyOptionsSchema.optional(),
  name: NonBlankTextSchema,
  data: z.record(z.string(), z.unknown()).optional(),
  extractData: z.boolean().optional(),
}) satisfies z.ZodType<ObserveEventInput>;

const ObserveDocumentInputSchema = z.object({
  extractionContext: ExtractionContextSchema.optional(),
  kind: z.literal("document"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  subjectCandidates: SubjectCandidatesInputSchema,
  attributes: AttributesSchema.optional(),
  claimKey: ClaimKeyOptionsSchema.optional(),
  title: z.string().min(1).optional(),
  content: NonBlankTextSchema,
  extractTitle: z.boolean().optional(),
}) satisfies z.ZodType<ObserveDocumentInput>;

const ObserveMemoryUsageInputSchema = z.object({
  kind: z.literal("memory_usage"),
  externalId: z.string().min(1).optional(),
  recallId: z.string().min(1),
  usedMemoryIds: z.array(z.string().min(1)).min(1),
}) satisfies z.ZodType<ObserveMemoryUsageInput>;

export const ObserveInputSchema = z.discriminatedUnion("kind", [
  ObserveUtteranceInputSchema,
  ObserveEventInputSchema,
  ObserveDocumentInputSchema,
  ObserveMemoryUsageInputSchema,
]) satisfies z.ZodType<ObserveInput>;

/**
 * `observe()` の入力ユニオンの判別子を、`observations.kind` 列の値へ変換する。
 *
 * `memory_usage` だけは DB 列としては `'usage'` に対応する
 * （docs/memory-model.md §10: 「`kind = 'usage'` の Observation」）。
 * それ以外は判別子をそのまま列の値として使う。
 */
export function observeInputKindToObservationKind(kind: ObserveInputKind): string {
  switch (kind) {
    case "memory_usage":
      return "usage";
    case "utterance":
      return "utterance";
    case "event":
      return "event";
    case "document":
      return "document";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unreachable observe input kind: ${String(exhaustive)}`);
    }
  }
}
