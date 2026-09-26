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
 * `__tests__/unreachable-union-values.test.ts` は今も `"events_purged"` を棚卸しに残している。
 * あの歯は `kind: "events_purged"` というオブジェクトリテラルを文字列一致で探すので、
 * Postgres の書き手（SQL の文字列 `'events_purged'`）を見つけられない。
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
  type: "human" | "system" | "clone";
  id?: string;
}

export const EventActorSchema = z.object({
  type: z.enum(["human", "system", "clone"]),
  id: z.string().min(1).optional(),
}) satisfies z.ZodType<EventActor>;

/**
 * append-only な監査ログの1行（docs/memory-model.md §9）。
 * `EventStore` interface が `update`/`delete` を持たないことと対になる型。
 */
export interface MemoryEvent {
  id: EventId;
  tenantId: string;
  /** `kind = 'events_purged'` の場合のみ null。 */
  memoryId: MemoryId | null;
  kind: MemoryEventKind;
  at: Date;
  actor: EventActor;
  digestSnapshot?: string | null;
  sizeBeforeBytes?: number | null;
  meta: Record<string, unknown>;
}

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

export type NewMemoryEvent = Omit<MemoryEvent, "id" | "at"> & { at?: Date };

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

export interface EventFilter {
  memoryId?: MemoryId;
  kind?: MemoryEventKind;
  since?: Date;
  until?: Date;
  limit?: number;
}

export const EventFilterSchema = z.object({
  memoryId: z.string().min(1).optional(),
  kind: MemoryEventKindSchema.optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<EventFilter>;
