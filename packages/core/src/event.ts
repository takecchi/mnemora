import { z } from "zod";
import type { EventId, MemoryId } from "./ids.js";

/**
 * 監査ログのイベント種別（docs/memory-model.md §9）。
 * 「状態が実際に変わった大分類」だけを列挙し、理由の粒度は `meta` に落とす。
 *
 * - `"purged"`: `Runtime.purge` が組み立て、`MemoryStore.purgeMemory` が本文のトゥームストーン上書きと
 *   同じトランザクションで積む（[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）。
 * - `"events_purged"`: `MemoryStore.purgeExpiredEvents`（任意メソッド）が、期限切れの行を消すのと同じ
 *   トランザクションで `memory_id = NULL` の1行を積む（[ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)）。
 *   core はイベントを組み立てず、adapter が書く。
 * - `"restored"`（`Runtime.restoreArchived`、[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md)）と
 *   `"unsuperseded"`（`Runtime.restoreSuperseded`）: `kind:"updated"` + `meta.reason` に寄せず、
 *   `"restored"` も再利用しないのは、`idx_memory_events_by_kind` で「archive から戻った」と
 *   「supersede を取り消した」を索引で分けて引けるようにするため（ADR 0122）。
 */
export type MemoryEventKind =
  | "created"
  | "updated"
  | "superseded"
  | "archived"
  | "forgotten"
  | "purged"
  | "events_purged"
  | "restored"
  | "unsuperseded";

/** `MemoryEventKind` の zod スキーマ。値を実行時に検査するときに使う（型 `MemoryEventKind` と揃えてある）。 */
export const MemoryEventKindSchema = z.enum([
  "created",
  "updated",
  "superseded",
  "archived",
  "forgotten",
  "purged",
  "events_purged",
  "restored",
  "unsuperseded",
]) satisfies z.ZodType<MemoryEventKind>;

/**
 * `type: "human" | "clone"` は同梱の本番コードからは生成されない（実際に書かれる actor は
 * `{ type: "system" }` だけ）。ただし `actor` は `Runtime`（`applyCorrection`・`markContested` 等）の各口が
 * 受け取る公開パラメータで、呼び出し側が「人間が行った訂正」「クローンが行った書き込み」と申告するために
 * ある。型の外側に構造的な壁は無い（ADR 0117・0144 が扱った「構造的に到達不能な union 値」とは別）。
 */
export interface EventActor {
  /** 誰が行ったか。`"system"` は runtime 自身（自動の job など）、`"human"`・`"clone"` は呼び出し側が申告する（上の doc）。 */
  type: "human" | "system" | "clone";
  /**
   * 中身は検査しない。NUL（U+0000）か孤立サロゲートを含むと、`@mnemora/postgres` でも
   * `@mnemora/testkit` の fixture でも監査ログの書き込みが失敗する（{@link MemoryEvent.meta} の doc 参照）。
   */
  id?: string;
}

/**
 * `EventActor` の zod スキーマ。値を実行時に検査するときに使う（型 `EventActor` と揃えてある）。
 *
 * ⚠ **この schema は store より厳しい**（`ctx.ts` の `CtxSchema` と同じ形の差）。`id` に
 * `min(1)` を書いているので空文字の `id` を拒むが、`EventStore.append` も `MemoryStore` の書き込みの口も
 * この schema で `actor` を検査しないので、`{ type: "human", id: "" }` はそのまま保存される。
 * `@mnemora/postgres`・testkit の fixture・core の Fake の3実装で同じ。
 */
export const EventActorSchema = z.object({
  type: z.enum(["human", "system", "clone"]),
  id: z.string().min(1).optional(),
}) satisfies z.ZodType<EventActor>;

/**
 * append-only な監査ログの1行（docs/memory-model.md §9）。
 * `EventStore` interface が `update`/`delete` を持たないことと対になる型。
 */
export interface MemoryEvent {
  /** イベントの id。 */
  id: EventId;
  /** イベントが属するテナント。 */
  tenantId: string;
  /**
   * 対象の Memory の id。**`kind = 'events_purged'` のときは必ず `null`**（{@link MemoryEventSchema} の refine と、
   * `@mnemora/postgres`・testkit の fixture が拒む。例外の種類は adapter で違う）。
   *
   * ⚠ **ほかの `kind` でも `null` は拒まない。**`EventStore.append` などに
   * `{ kind: "created", memoryId: null }` を渡すと、Postgres も fixture もそのまま書いて返す（`MemoryEventSchema` も
   * 通る）。同梱のコードが `null` で書くのは、store の `purgeExpiredEvents` が積む `events_purged` だけ。
   */
  memoryId: MemoryId | null;
  /** 何が起きたか（{@link MemoryEventKind}）。 */
  kind: MemoryEventKind;
  /** 起きた時刻。 */
  at: Date;
  /** 誰が行ったか（{@link EventActor}）。 */
  actor: EventActor;
  /** 記録した時点の Memory の `digest` の写し（本文は写さない）。purge の後も、何が消えたかを digest で読める。 */
  digestSnapshot?: string | null;
  /** 削除・置換の直前の大きさ（バイト）。⚠ runtime も同梱の store もこの欄に値を書かない（`null`）。 */
  sizeBeforeBytes?: number | null;
  /**
   * `kind` 固有の付帯情報（`docs/memory-model.md` §9）。
   *
   * ⚠ **`meta` と `actor` は JSON として保存される前提の欄である。**値の中身は検査しない。保証するのは、JSON の値
   * （有限の数・文字列・真偽値・`null`・配列・プレーンなオブジェクト）が同じ値で読み戻ることだけである。
   * core が自分で入れる値（`reason`・`note`・id・id の配列）は、どれも JSON で往復する。
   *
   * | 値 | `@mnemora/postgres`（`JSON.stringify` して `jsonb` に保存） | `@mnemora/testkit` の fixture |
   * |---|---|---|
   * | `Date` | ISO 8601 の文字列に変わる | そのまま保持する |
   * | `NaN`・`Infinity`・`-Infinity` | `null` に変わる | そのまま保持する |
   * | `-0` | `0` に変わる | そのまま保持する |
   * | `undefined` の欄（`actor.id` も） | 欄ごと消える | `undefined` の欄が残る |
   * | BigInt（入れ子・配列の要素も） | 例外（`TypeError: Do not know how to serialize a BigInt`。`append` が失敗する） | **同じ `TypeError`・同じ文言で拒む。**状態もイベントも書く前に投げる |
   * | 文字列の中の NUL（U+0000）・孤立サロゲート | 例外（書き込みが失敗する） | 例外（`Error`。状態もイベントも書く前に投げる） |
   * | 関数・Symbol（欄の値として。`actor` の欄も） | その欄が消える（配列の要素なら `null`）。残りを書いて成功する | 例外（`DataCloneError`。`structuredClone` が写せない）。状態もイベントも書く前に投げる |
   *
   * ⚠ **BigInt の行は他のどの行よりも先に評価される。**`@mnemora/postgres` の `EventStore.append` は
   * `INSERT` の引数を全部 JS 側で評価してから DB へ問い合わせを送るため、`actor`/`meta` のどこかに BigInt が
   * あると、`kind` が列挙に無くても・`memoryId` が実在しなくても・`at` が Invalid Date でも・NUL/孤立サロゲートが
   * あっても、Postgres 自身の検査の前に `TypeError` になる。fixture 側の `assertStorableMemoryEvent` も
   * この優先順位に合わせ、BigInt の検査を最初に置いている。
   *
   * NUL・孤立サロゲートの行は、`Runtime` の口に渡す `reason`（`meta.reason` か `meta.note` に入る）と `actor.id` にも当たる。
   * `@mnemora/postgres` では、状態の書き換えとイベントが同じトランザクションにあるので、両方とも取り消され、
   * 途中まで書かれたものは残らない（`forget` は `{ kind: "failed" }` を返し、`markContested` は DB に触れる前の名指しの `Error` を投げる——ADR 0499）。
   * **testkit の fixture も同じ入力を拒む。**`assertStorableMemoryEvent` が状態を書き換える前に `Error` を投げ、
   * `Runtime.forget` はそれを捕まえて `{ kind: "failed" }` にし、`Runtime.markContested` は捕まえずに外へ投げる
   * （`@mnemora/postgres` が同じ口で外へ見せる形と揃う）。Observation・Memory の `jsonb` の欄では fixture も NUL を拒むが、
   * 孤立サロゲートは Postgres の `jsonb` だけが拒む（イベントの `meta`/`actor` は NUL・孤立サロゲートの両方を拒むのとは違う）。
   */
  meta: Record<string, unknown>;
}

/** `MemoryEvent` の zod スキーマ。値を実行時に検査するときに使う（型 `MemoryEvent` と揃えてある）。 */
export const MemoryEventSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    memoryId: z.string().min(1).nullable(),
    kind: MemoryEventKindSchema,
    at: z.date(),
    actor: EventActorSchema,
    digestSnapshot: z.string().nullable().optional(),
    sizeBeforeBytes: z.number().int().nonnegative().nullable().optional(),
    meta: z.record(z.string(), z.unknown()),
  })
  .refine((event) => event.kind !== "events_purged" || event.memoryId === null, {
    message: "events_purged のイベントは memoryId が null でなければならない",
    path: ["memoryId"],
  }) satisfies z.ZodType<MemoryEvent>;

/** `EventStore.append` に渡す新しいイベント。`id` は store が付け、`at` は省略すると store が今の時刻を入れる。 */
export type NewMemoryEvent = Omit<MemoryEvent, "id" | "at"> & { at?: Date | undefined };

/** `NewMemoryEvent` の zod スキーマ。値を実行時に検査するときに使う（型 `NewMemoryEvent` と揃えてある）。 */
export const NewMemoryEventSchema = z
  .object({
    tenantId: z.string().min(1),
    memoryId: z.string().min(1).nullable(),
    kind: MemoryEventKindSchema,
    at: z.date().optional(),
    actor: EventActorSchema,
    digestSnapshot: z.string().nullable().optional(),
    sizeBeforeBytes: z.number().int().nonnegative().nullable().optional(),
    meta: z.record(z.string(), z.unknown()),
  })
  .refine((event) => event.kind !== "events_purged" || event.memoryId === null, {
    message: "events_purged のイベントは memoryId が null でなければならない",
    path: ["memoryId"],
  }) satisfies z.ZodType<NewMemoryEvent>;

/** `EventStore.list` の絞り込み。どの欄も省略でき、渡した条件をすべて満たす行を `at` の古い順に返す。 */
export interface EventFilter {
  /** この Memory のイベントだけを返す。 */
  memoryId?: MemoryId | undefined;
  /** この種類のイベントだけを返す。 */
  kind?: MemoryEventKind | undefined;
  /** `at` がこの時刻以後のイベントだけを返す（境界を含む）。 */
  since?: Date | undefined;
  /** `at` がこの時刻以前のイベントだけを返す（境界を含む）。 */
  until?: Date | undefined;
  /**
   * 返す上限の件数（古い順の先頭から）。省略なら全件。負数・非整数は例外になる（`@mnemora/postgres` と testkit の fixture で同じ）。
   * `0` は例外にならず、0件を返す（{@link EventFilterSchema} は `0` を拒むので、schema と store で違う）。
   */
  limit?: number | undefined;
}

/**
 * `EventFilter` の zod スキーマ。値を実行時に検査するときに使う（型 `EventFilter` と揃えてある）。
 *
 * ⚠ **この schema は store より厳しい**（`ctx.ts` の `CtxSchema` と同じ形の差）。`limit` に
 * `positive()` を書いているので `limit: 0` を拒むが、`EventStore.list` はこの schema でフィルタを検査しないので、
 * `limit: 0` は例外にならず0件を返す（負数・非整数は store も例外にする）。
 * `@mnemora/postgres`・testkit の fixture・core の Fake の3実装で同じ。
 */
export const EventFilterSchema = z.object({
  memoryId: z.string().min(1).optional(),
  kind: MemoryEventKindSchema.optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<EventFilter>;
