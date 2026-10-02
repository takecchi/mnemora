import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventFilter,
  EventId,
  EventStore,
  MemoryEvent,
  NewMemoryEvent,
} from "@mnemora/core";
import { assertWellFormedCtx } from "@mnemora/core";
import type { Db } from "./client.js";
import { assertNoNulInNewMemoryEvent } from "./input-check.js";
import { omittingParams } from "./omit-params.js";
import {
  isUuidLike,
  normalizeUuidCase,
  rowToMemoryEvent,
  toPgTimestamp,
  type MemoryEventRow,
} from "./mapping.js";

function memoryNotFound(id: string): Error {
  return new Error(`PostgresEventStore: memory not found for tenant: ${id}`);
}

/**
 * `EventStore` の Postgres 実装（docs/architecture.md §5.8、docs/memory-model.md §9）。
 *
 * **`update` / `delete` に相当するメソッドを一切持たない。** append-only は型だけでなく
 * 実装としても徹底する。
 */
export class PostgresEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  /**
   * ADR 0436 決定1・2・3: `event.memoryId` が非 null のとき、その記憶が `ctx.tenantId` の記憶であることを
   * **書く前に**確かめる。実在しない・別のテナントの記憶・uuid の形でない id は、行を書かずに
   * `PostgresEventStore: memory not found for tenant: <id>` を含む `Error` を投げる（区別しない）。
   * 確かめと書き込みは1つの SQL 文（検査の EXISTS と、`WHERE ok` で絞った INSERT の CTE）——間に別の文が挟まらない。
   * `memoryId` が null のイベント（`events_purged`）は記憶を指さないので検査しない。
   */
  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    assertWellFormedCtx(ctx);
    // ADR 0499: NUL は DB の生の例外でなく、名指しの例外で断る（INSERT の前。memoryId の形の検査より後ろ——
    // 形の壊れた memoryId は、今までどおり「memory not found」が先）。
    if (event.memoryId === null) {
      assertNoNulInNewMemoryEvent("PostgresEventStore", event);
      // ADR 0505: 例外の message（`cause` の連鎖を含む）から、SQL に付けた値（params。meta・digestSnapshot）を落とす。
      const result = await omittingParams(() =>
        this.db.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${null},
          ${event.kind},
          ${toPgTimestamp(event.at ?? new Date())},
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null},
          ${event.sizeBeforeBytes ?? null},
          ${JSON.stringify(event.meta)}::jsonb
        )
        RETURNING *
      `),
      );
      return rowToMemoryEvent(result.rows[0] as unknown as MemoryEventRow);
    }
    const memoryId = normalizeUuidCase(event.memoryId);
    if (!isUuidLike(memoryId)) {
      throw memoryNotFound(memoryId);
    }
    assertNoNulInNewMemoryEvent("PostgresEventStore", event);
    // 検査で落ちたかは、戻り値の `tenant_check_ok`（検査の結果そのもの）で見る（ADR 0398 決定2 と同じ作法）。
    const result = await omittingParams(() =>
      this.db.execute(sql`
      WITH mem AS (
        SELECT EXISTS (
          SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${memoryId}
        ) AS ok
      ),
      ins AS (
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        SELECT
          gen_random_uuid(),
          ${ctx.tenantId},
          ${memoryId}::uuid,
          ${event.kind},
          ${toPgTimestamp(event.at ?? new Date())}::timestamptz,
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null}::text,
          ${event.sizeBeforeBytes ?? null}::integer,
          ${JSON.stringify(event.meta)}::jsonb
        FROM mem
        WHERE ok
        RETURNING *
      )
      SELECT mem.ok AS tenant_check_ok, ins.*
      FROM mem
      LEFT JOIN ins ON true
    `),
    );
    const row = result.rows[0] as unknown as
      (MemoryEventRow & { tenant_check_ok: boolean }) | undefined;
    if (!row?.tenant_check_ok) {
      throw memoryNotFound(memoryId);
    }
    return rowToMemoryEvent(row);
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    assertWellFormedCtx(ctx);
    // id 列は uuid 型。この口の契約は「無い == null」なので、形式が壊れた入力も
    // クエリを投げる前に同じ null へ寄せる（mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memory_events WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0
      ? rowToMemoryEvent(result.rows[0] as unknown as MemoryEventRow)
      : null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    assertWellFormedCtx(ctx);
    // memory_id 列は uuid 型。この口の契約は「無い == []」なので、形式が壊れた
    // memoryId もクエリを投げる前に空配列へ寄せる（他のフィルタの値に関わらず、
    // memory_id の等値条件が絶対に一致しえない以上、結果は必ず空になるため）
    // （mapping.ts の isUuidLike の doc参照）。
    if (filter.memoryId !== undefined && !isUuidLike(filter.memoryId)) {
      return [];
    }
    const conditions = [sql`tenant_id = ${ctx.tenantId}`];
    if (filter.memoryId !== undefined) {
      conditions.push(sql`memory_id = ${filter.memoryId}`);
    }
    if (filter.kind !== undefined) {
      conditions.push(sql`kind = ${filter.kind}`);
    }
    if (filter.since !== undefined) {
      conditions.push(sql`at >= ${toPgTimestamp(filter.since)}`);
    }
    if (filter.until !== undefined) {
      conditions.push(sql`at <= ${toPgTimestamp(filter.until)}`);
    }
    const whereClause = sql.join(conditions, sql` AND `);
    const limitClause = filter.limit !== undefined ? sql`LIMIT ${filter.limit}` : sql``;

    const result = await this.db.execute(sql`
      SELECT * FROM memory_events WHERE ${whereClause} ORDER BY at ASC ${limitClause}
    `);
    return result.rows.map((row) => rowToMemoryEvent(row as unknown as MemoryEventRow));
  }
}
