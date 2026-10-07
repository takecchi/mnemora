import { z } from "zod";

/**
 * すべての interface のメソッドが第一引数に取る呼び出しコンテキスト。
 *
 * `tenantId` は隔離境界（安全性の単位）、`subjectId` はテナント内の整理の単位。
 * この非対称性を混同しない（docs/vision.md 「Tenant と Subject を混同しない」）。
 *
 * mnemora はテナントの台帳を持たない。`tenantId` は呼び出し側が渡す不透明な文字列であり、
 * 存在確認・認証は行わない（docs/architecture.md §3.7）。
 *
 * ⚠ **識別子の長さに上限は約束しない。**
 * `tenantId`・`subjectId`（ここと `observe` の入力、Memory）・`observe` の `externalId`・Memory の
 * `tags` の要素・`claimKey` の主語と述語は、schema が長さを検査しない。ただし `@mnemora/postgres` は
 * これらを btree / GIN の索引に入れるので、索引の1行（複合索引では同じ行のほかの欄との合計）が
 * **圧縮後に**上限（btree 2704 バイト、GIN 2712 バイト）を超えると、書き込みが例外になる
 * （`index row size … exceeds …`）。圧縮後の大きさで決まるので、上限は文字数でもバイト数でも
 * 一意に言えない（同じ文字の繰り返しは1万字でも通り、ランダムな値は約2.7KBで落ちる）。
 * `@mnemora/testkit` の fixture はどの長さも受け入れる。
 * `@mnemora/postgres` は、claim key の索引の上限で落ちる入力だけを、型付きの例外 `ClaimKeyIndexLimitError`
 * （`kind: "claim_key_index_limit"`、ADR 0435）で断る。**保証するのは、索引の1行が上の上限に
 * 収まる長さのときだけである。**長い外部の ID（URL の連結など）は、呼び出し側でハッシュなどに
 * 縮めてから渡すこと。
 *
 * ⚠ **識別子は正規化せず、完全一致で比べる。** `tenantId`・`subjectId`・`observe` の `externalId`・
 * `claimKey` の主語と述語・ラベル名・`tags` の要素は、大文字小文字、Unicode の正規化形（NFC と NFD）、
 * 全角半角、前後の空白が違えば**別の値**として扱う。`%`・`_`・`/`・`:` も普通の文字であり、`LIKE` や
 * 前方一致で別の識別子が混ざることは無い。同じものとして扱いたい表記の揺れは、呼び出し側で揃えてから渡すこと。
 *
 * ⚠ **識別子に孤立サロゲートか NUL（U+0000）が含まれていたら、入口で {@link MalformedIdentifierError}（`kind: "malformed_identifier"`）を投げて断る**
 * （[ADR 0423](../../../docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)。**正規化はしない**——書き換えて通さない）。
 * 対象は `tenantId`・`subjectId`（この `Ctx` と `observe` の入力、Memory・Observation の書き込み、検索条件の `filter`）と `observe` の `externalId`。
 * **`Runtime` の全メソッドの入口と、同梱の store（`@mnemora/postgres`・`@mnemora/testkit` のインメモリ実装）の `ctx` を取る全メソッドの入口**で同じ判定
 * （{@link assertWellFormedIdentifier}）を掛ける。対をなすサロゲート（絵文字など）は断らない。
 * 本文（`text`・`content` など）には掛けない。`tags` の要素・`claimKey` の主語と述語・ラベル名は対象にしていない。
 * 自前の store を書くときは、同じ {@link assertWellFormedCtx} を入口で呼ぶこと（適合テストが検査する）。
 *
 * ⚠ **`ctx` の空文字・空白だけの値も受け付ける。**{@link CtxSchema} は `min(1)` を書いているが、
 * `Runtime` も同梱の store もこの schema で `ctx` を検査しないので、`tenantId: ""` や `subjectId: "   "` は
 * そのまま1つのテナント・主題として動く（`claimKey` の主語と述語・ラベル名・`tags` の要素も同じ）。
 * 一方、`observe` の入力 schema（`ObserveInputSchema`、`observation.ts`）は、次の欄の空文字・空配列を
 * `ZodError` にする。`utterance` の `text`・`event` の `name`・`document` の `content` は空白だけの文字列も断る
 * （ADR 0502）。ほかの欄は空白だけの文字列を受け付ける。
 * - 文字列が空文字だと断る: `subjectId`・`externalId`（4種類すべての `kind`。`memory_usage` は `subjectId` を持たない）、
 *   `utterance` の `speaker`・`text`、`event` の `name`、`document` の `title`・`content`、`memory_usage` の `recallId`。
 * - 配列の要素が空文字だと断る: `subjectCandidates`・`memory_usage` の `usedMemoryIds`・`claimKey.knownPredicates`・
 *   `claimKey.knownSubjects`。
 * - 配列そのものが空だと断る: `memory_usage` の `usedMemoryIds`（`subjectCandidates` の空配列は受け付け、「渡していない」と同じに扱う）。
 * - 入れ子の欄: `extractionContext.messages[].text`・`extractionContext.messages[].speaker`・`extractionContext.timeZone`、
 *   `attributes` のキー（`ATTRIBUTE_KEY_MIN_LENGTH` = 1）。
 *
 * つまり `ctx.subjectId: ""` は通るが、`observe` の入力の `subjectId: ""` は断られる。
 * また、`observe` の入力の**未知のキーは、例外にも警告にもならず黙って捨てられる**（`ObserveInputSchema` は
 * `.strict()` ではない）。`subjectid` のような綴り違いは、無いものとして扱われる。
 *
 * ⚠ **空文字の `tenantId`・`subjectId` は受け付けるが、出力の側の schema を通らない値を作る。**
 * `subjectId: ""` で書いた記憶を `recall()` が返すと `RecalledMemory.subjectId` が `""` になり
 * （`RecalledMemorySchema` は `min(1)`）、`recall()` の `outputValidation` が `ok: false` になる。
 * `tenantId: ""` で積んだ outbox のジョブは `OutboxJobRecord.tenantId` が `""` になり、`OutboxJobRecordSchema`
 * （`min(1)`）を通らない。
 */
export interface Ctx {
  /** 隔離の単位（必須）。呼び出し側が渡す不透明な文字列で、store はこの値で行を分ける。跨いだら事故である。 */
  tenantId: string;
  /** テナントの中の整理の単位（利用者など。省略できる）。**省略すると、テナント全体が対象になる**（packages/core/README.md）。書き込む口では、主題の無い記憶として扱う。 */
  subjectId?: string;
}

/** `Ctx` の zod スキーマ。値を実行時に検査するときに使う（型 `Ctx` と揃えてある）。 */
export const CtxSchema = z.object({
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).optional(),
}) satisfies z.ZodType<Ctx>;
