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
  toPgTimestampClamped,
  type MemoryEventRow,
} from "./mapping.js";

function memoryNotFound(id: string): Error {
  return new Error(`PostgresEventStore: memory not found for tenant: ${id}`);
}

/**
 * `EventStore` の Postgres 実装。`update` / `delete` に相当するメソッドを一切持たない（append-only）。
 */
export class PostgresEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  /**
   * `event.memoryId` が非 null のとき、その記憶が `ctx.tenantId` の記憶であることを**書く前に**確かめる
   * （ADR 0436）。実在しない・別のテナントの記憶・uuid の形でない id は、行を書かずに
   * `PostgresEventStore: memory not found for tenant: <id>` を含む `Error` を投げる（区別しない）。
   * `memoryId` が null のイベント（`events_purged`）は記憶を指さないので検査しない。
   */
  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    assertWellFormedCtx(ctx);
    // 形の壊れた memoryId は NUL の検査より先に「memory not found」で断る。
    if (event.memoryId === null) {
      assertNoNulInNewMemoryEvent("PostgresEventStore", event);
      // 例外の message（`cause` の連鎖を含む）から、SQL に付けた値（params）を落とす（ADR 0505）。
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
    // 検査で落ちたかは、戻り値の `tenant_check_ok`（検査の結果そのもの）で見る。
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
    // 形式が壊れた id は、クエリを投げる前に「無い」と同じ null へ寄せる。
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
    // 形式が壊れた memoryId は、他のフィルタに関わらず結果が必ず空なので、クエリを投げる前に空配列へ寄せる。
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
      conditions.push(sql`at >= ${toPgTimestampClamped(filter.since)}`);
    }
    if (filter.until !== undefined) {
      conditions.push(sql`at <= ${toPgTimestampClamped(filter.until)}`);
    }
    const whereClause = sql.join(conditions, sql` AND `);
    const limitClause = filter.limit !== undefined ? sql`LIMIT ${filter.limit}` : sql``;

    const result = await this.db.execute(sql`
      SELECT * FROM memory_events WHERE ${whereClause} ORDER BY at ASC ${limitClause}
    `);
    return result.rows.map((row) => rowToMemoryEvent(row as unknown as MemoryEventRow));
  }
}
