import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventFilter,
  EventId,
  EventStore,
  MemoryEvent,
  NewMemoryEvent,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { isUuidLike, rowToMemoryEvent, type MemoryEventRow } from "./mapping.js";

/**
 * `EventStore` の Postgres 実装（docs/architecture.md §5.8、docs/memory-model.md §9）。
 *
 * **`update` / `delete` に相当するメソッドを一切持たない。** append-only は型だけでなく
 * 実装としても徹底する。
 */
export class PostgresEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    const result = await this.db.execute(sql`
      INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${event.memoryId},
        ${event.kind},
        ${event.at ?? new Date()},
        ${JSON.stringify(event.actor)}::jsonb,
        ${event.digestSnapshot ?? null},
        ${event.sizeBeforeBytes ?? null},
        ${JSON.stringify(event.meta)}::jsonb
      )
      RETURNING *
    `);
    return rowToMemoryEvent(result.rows[0] as unknown as MemoryEventRow);
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
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
      conditions.push(sql`at >= ${filter.since}`);
    }
    if (filter.until !== undefined) {
      conditions.push(sql`at <= ${filter.until}`);
    }
    const whereClause = sql.join(conditions, sql` AND `);
    const limitClause = filter.limit !== undefined ? sql`LIMIT ${filter.limit}` : sql``;

    const result = await this.db.execute(sql`
      SELECT * FROM memory_events WHERE ${whereClause} ORDER BY at ASC ${limitClause}
    `);
    return result.rows.map((row) => rowToMemoryEvent(row as unknown as MemoryEventRow));
  }
}
