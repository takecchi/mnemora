import { z } from "zod";
import type { EventId, MemoryId } from "./ids.js";

/**
 * 監査ログのイベント種別（docs/memory-model.md §9）。
 * 「状態が実際に変わった大分類」だけを列挙し、理由の粒度は `meta` に落とす。
 *
 * **`"purged"` と `"events_purged"` は、どちらも本番コードから実際に書かれる。**
 * - `"purged"`: `Runtime.purge`（`createRuntime` の中の `purge`）が `kind: "purged"` の
 *   イベントを組み立て、`MemoryStore.purgeMemory`（Postgres は `PostgresMemoryStore.purgeMemory`）が
 *   本文のトゥームストーン上書きと同じトランザクションで `memory_events` に積む
 *   （Issue #198 / [ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）。
 * - `"events_purged"`: `MemoryStore.purgeExpiredEvents`（任意メソッド。Postgres は
 *   `PostgresMemoryStore.purgeExpiredEvents`）が、期限切れの行を消すのと同じトランザクションで
 *   `memory_id = NULL` の1行を積む（Issue #210 / [ADR 0115](../../../docs/decisions/0115-event-retention-purge.md)）。
 *   core はイベントを組み立てず、adapter が生の SQL で書く。
 *
 * ⚠ **2026-09-26 訂正**: この段落は以前「どちらも生成するコードが無い」と書いていた
 * （Issue #206 / [ADR 0117](../../../docs/decisions/0117-unreachable-union-values-inventory.md) の
 * 棚卸しの時点の記述）。その後、上の2つの書き手が入ったが、この段落は追いついていなかった。
 * `__tests__/unreachable-union-values.test.ts` も `"events_purged"` を棚卸しに残したまま緑だった。
 * あの歯は `kind: "events_purged"` というオブジェクトリテラルを文字列一致で探すので、
 * Postgres の書き手（SQL の文字列 `'events_purged'`）を見つけられない。2026-09-26 に棚卸しから外した。
 *
 * **`"restored"`（Issue #195、[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md)）
 * も、この PR から実際に生成される。**`Runtime.restoreArchived` が
 * `status='archived'` → `status='active'` の遷移（`docs/memory-model.md` §11 行14）で
 * 積む。既存の網羅的な `switch (event.kind)` は出荷対象パッケージ（`packages/core`・
 * `packages/postgres`・`packages/openai`・`packages/local-embedding`・
 * `packages/anthropic`）のどこにも無いことを確認した上で追加している
 * （`rg -n "switch" packages/*\/src` の結果に `MemoryEventKind` を分岐する箇所は無い）
 * ——union へ値を足すことが破壊的変更になる経路（網羅的 switch）がこの repo に
 * 存在しないため、追加である。
 *
 * **`"unsuperseded"`（`Runtime.restoreSuperseded`、superseded → active の復旧口）も
 * 同じ理由で追加する。** `"restored"` を再利用しない理由（`kind:"updated"` +
 * `meta.reason` に寄せない理由と同じ形の判断）: `idx_memory_events_by_kind`
 * （`tenant_id, kind, at`）で監査ログを引くとき、「archive から戻った」
 * （`restoreArchived`）と「supersede を取り消した」（`restoreSuperseded`）が
 * 同じ `kind` だと索引で分けて引けない——ADR 0122 が `"updated"` の再利用を却下して
 * `"restored"` を新設したのと同じ理由で、`"restored"` の再利用も却下し専用の値を足す。
 * 追加が破壊的変更にならないことは、上の `"restored"` を足したときの確認がそのまま
 * 当てはまる（この PR の時点で改めて `rg -n "switch" packages/*\/src` を確認しても、
 * `MemoryEventKind` を分岐する網羅的 `switch` はこの repo のどこにも無い）。
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
 * `type: "human" | "clone"` は本番コード（`examples/chat` 含む）のどこからも生成されない
 * ——実際に書かれる actor は `{ type: "system" }` だけである。**ただしこれは
 * Issue #206 / ADR 0117・0144 が扱った「構造的に到達不能な union 値」とは別の性質である
 * **——`actor` は `Runtime`（`applyCorrection`・`markContested` 等）の各口が受け取る
 * 公開パラメータで、呼び出し側が「これは人間が行った訂正である」「これはクローンが行った
 * 書き込みである」と申告するために存在する。今日それを渡す呼び出し元（人間参加型・
 * クローン参加型のワークフロー）が repo 内に無いだけであり、型の外側に構造的な壁は無い
 * （Issue #168 の棚卸し項目13-3）。
 */
export interface EventActor {
  /** 誰が行ったか。`"system"` は runtime 自身（自動の job など）、`"human"`・`"clone"` は呼び出し側が申告する（上の doc）。 */
  type: "human" | "system" | "clone";
  /**
   * 中身は検査しない。NUL（U+0000）か孤立サロゲートを含むと、`@mnemora/postgres` でも
   * `@mnemora/testkit` の fixture でも監査ログの書き込みが失敗する——
   * {@link MemoryEvent.meta} の doc 参照（Issue #1211）。
   */
  id?: string;
}

/**
 * `EventActor` の zod スキーマ。値を実行時に検査するときに使う（型 `EventActor` と揃えてある）。
 *
 * ⚠ **この schema は store より厳しい**（今の振る舞い。`ctx.ts` の `CtxSchema` と同じ形の差）。`id` に
 * `min(1)` を書いているので空文字の `id` を拒むが、`EventStore.append` も `MemoryStore` の書き込みの口も
 * この schema で `actor` を検査しないので、`{ type: "human", id: "" }` はそのまま保存される。
 * 【実測 2026-09-28】`@mnemora/postgres`・testkit の fixture・core の Fake の3実装で同じ。
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
   * ⚠ 2026-09-28 追記（今の振る舞い）: **ほかの `kind` でも `null` は拒まない。**`EventStore.append` などに
   * `{ kind: "created", memoryId: null }` を渡すと、Postgres も fixture もそのまま書いて返す（`MemoryEventSchema` も
   * 通る）。同梱のコードが `null` で書くのは、store の `purgeExpiredEvents` が積む `events_purged` だけである
   * ——`Runtime` が書くイベントは、どれも対象の Memory の id を持つ（`packages/core/src` を grep して確かめた）。
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
  /** 削除・置換の直前の大きさ（バイト）。⚠ 今は runtime も同梱の store もこの欄に値を書かない（`null`）。 */
  sizeBeforeBytes?: number | null;
  /**
   * `kind` 固有の付帯情報（`docs/memory-model.md` §9）。
   *
   * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1211](https://github.com/takecchi/mnemora/issues/1211)）:
   * `meta` と `actor` は JSON として保存される前提の欄である。**値の中身は検査しない。保証するのは、JSON の値
   * （有限の数・文字列・真偽値・`null`・配列・プレーンなオブジェクト）が同じ値で読み戻ることだけである。
   * core が自分で入れる値（`reason`・`note`・id・id の配列）は、どれも JSON で往復する。
   *
   * | 値 | `@mnemora/postgres`（`JSON.stringify` して `jsonb` に保存） | `@mnemora/testkit` の fixture |
   * |---|---|---|
   * | `Date` | ISO 8601 の文字列に変わる | そのまま保持する |
   * | `NaN`・`Infinity`・`-Infinity` | `null` に変わる | そのまま保持する |
   * | `-0` | `0` に変わる | そのまま保持する |
   * | `undefined` の欄（`actor.id` も） | 欄ごと消える | `undefined` の欄が残る |
   * | BigInt（入れ子・配列の要素も） | 例外（`TypeError: Do not know how to serialize a BigInt`。`append` が失敗する） | **2026-09-29 追記（Issue #1384）: 同じ `TypeError`・同じ文言で拒む。**状態もイベントも書く前に投げる。以前は fixture がそのまま保持していた |
   * | 文字列の中の NUL（U+0000）・孤立サロゲート | 例外（書き込みが失敗する） | 例外（`Error`。状態もイベントも書く前に投げる） |
   * | 関数・Symbol（欄の値として。`actor` の欄も） | その欄が消える（配列の要素なら `null`）。残りを書いて成功する | 例外（`DataCloneError`。`structuredClone` が写せない）。状態もイベントも書く前に投げる（PR #1231） |
   *
   * ⚠ **BigInt の行は他のどの行よりも先に評価される。**`@mnemora/postgres` の `EventStore.append` は
   * `INSERT` の引数（`actor`・`meta` を含む）を全部 JS 側で評価してから初めて DB へ問い合わせを送るため、
   * `actor`/`meta` のどこかに BigInt があると、`kind` が列挙に無くても・`memoryId` が実在しなくても・
   * `at` が Invalid Date でも・NUL/孤立サロゲートがあっても、**それらを Postgres 自身が検査する機会が
   * 無いまま `TypeError` になる**（【実測 2026-09-29】`kind` 不正・`at` Invalid Date・`memoryId` 実在しない、
   * のそれぞれと `meta` の BigInt を同時に渡し、いずれも `TypeError: Do not know how to serialize a BigInt`
   * になることを確認した）。fixture 側の `assertStorableMemoryEvent` もこの優先順位に合わせ、BigInt の検査を
   * 最初に置いている。
   *
   * NUL・孤立サロゲートの行は、`Runtime` の口に渡す `reason`（`meta.reason` か `meta.note` に入る）と `actor.id` にも当たる。
   * `@mnemora/postgres` では、状態の書き換えとイベントが同じトランザクションにあるので、両方とも取り消され、
   * 途中まで書かれたものは残らない（`forget` は `{ kind: "failed" }` を返し、`markContested` は DB の例外を投げる）。
   * **testkit の fixture も、2026-09-29 から同じ入力を拒むようになった**（[Issue #1211](https://github.com/takecchi/mnemora/issues/1211)、
   * オーナーの回答 ask_human `3f3411c5` を受けて。以前は状態を書き換え、文字列をそのまま監査ログに残していた）
   * ——`assertStorableMemoryEvent`（`packages/testkit/src/__fixtures__/memory-event-check.ts`）が状態を書き換える前に
   * `Error` を投げる。`Runtime.forget` はそれを捕まえて `{ kind: "failed" }` にし、`Runtime.markContested` は
   * 捕まえずに外へ投げる——どちらも `@mnemora/postgres` が同じ口で外へ見せる形と揃う。
   * Observation・Memory の `jsonb` の欄では fixture も NUL を拒む（PR #1073）が、孤立サロゲートは #1075 のとおり
   * Postgres の `jsonb` だけが拒む（イベントの側とは違う——イベントの `meta`/`actor` はこの PR で NUL・孤立サロゲートの
   * 両方を拒むようになったが、Observation/Memory の `jsonb` 欄の孤立サロゲートは対象外のまま。#1211 の「重ならないもの」）。
   * 【実測 2026-09-27】`@mnemora/postgres` と testkit の fixture（`event-meta-roundtrip.postgres.test.ts`。
   * `Runtime` の口は `forget` と `markContested` で当てた）。関数・Symbol の行は 2026-09-28 に足した
   * （同じファイル。`EventStore.append` と `MemoryStore.updateStatusWithEvent` で当てた）。BigInt の行は
   * 2026-09-29 に揃えた（Issue #1384、同じファイルに歯を足した）。
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
export type NewMemoryEvent = Omit<MemoryEvent, "id" | "at"> & { at?: Date };

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
  memoryId?: MemoryId;
  /** この種類のイベントだけを返す。 */
  kind?: MemoryEventKind;
  /** `at` がこの時刻以後のイベントだけを返す（境界を含む）。 */
  since?: Date;
  /** `at` がこの時刻以前のイベントだけを返す（境界を含む）。 */
  until?: Date;
  /**
   * 返す上限の件数（古い順の先頭から）。省略なら全件。負数・非整数は例外になる（`@mnemora/postgres` と testkit の fixture で同じ）。
   * `0` は例外にならず、0件を返す（今の振る舞い。{@link EventFilterSchema} は `0` を拒むので、schema と store で違う）。
   */
  limit?: number;
}

/**
 * `EventFilter` の zod スキーマ。値を実行時に検査するときに使う（型 `EventFilter` と揃えてある）。
 *
 * ⚠ **この schema は store より厳しい**（今の振る舞い。`ctx.ts` の `CtxSchema` と同じ形の差）。`limit` に
 * `positive()` を書いているので `limit: 0` を拒むが、`EventStore.list` はこの schema でフィルタを検査しないので、
 * `limit: 0` は例外にならず0件を返す（負数・非整数は store も例外にする）。【実測 2026-09-28】
 * `@mnemora/postgres`・testkit の fixture・core の Fake の3実装で同じ。
 */
export const EventFilterSchema = z.object({
  memoryId: z.string().min(1).optional(),
  kind: MemoryEventKindSchema.optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<EventFilter>;
