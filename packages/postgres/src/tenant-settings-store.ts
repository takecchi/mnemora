import { sql } from "drizzle-orm";
import { assertValidEventRetentionDays, DEFAULT_HALF_LIFE_HOURS } from "@mnemora/core";
import type {
  Ctx,
  EventRetention,
  EventRetentionSetting,
  TenantSettingsStore,
} from "@mnemora/core";
import type { Db } from "./client.js";

/**
 * `TenantSettingsStore` の Postgres 実装（roadmap.md 段階3。`getEventRetention`/
 * `setEventRetention` は `docs/decisions/0050-tenant-event-retention.md` で追加）。
 *
 * `tenant_settings` に行が無いテナントは `DEFAULT_HALF_LIFE_HOURS`（DB 側の
 * `default_half_life_hours DEFAULT 720` と同じ値）を返す。DB の DEFAULT はあくまで
 * 「行が作られたとき」に効くものであり、行そのものが無い場合には効かないため、
 * アプリケーション側でも同じフォールバック値を持つ必要がある。
 */
export class PostgresTenantSettingsStore implements TenantSettingsStore {
  constructor(private readonly db: Db) {}

  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT default_half_life_hours FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    if (result.rows.length === 0) {
      return DEFAULT_HALF_LIFE_HOURS;
    }
    const row = result.rows[0] as unknown as { default_half_life_hours: number };
    return row.default_half_life_hours;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    const result = await this.db.execute(sql`
      SELECT event_retention_days FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    if (result.rows.length === 0) {
      return { kind: "unset" };
    }
    const row = result.rows[0] as unknown as { event_retention_days: number | null };
    if (row.event_retention_days === null) {
      return { kind: "unlimited" };
    }
    return { kind: "days", days: row.event_retention_days };
  }

  async setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
    }
    const days = retention.kind === "days" ? retention.days : null;
    // `default_half_life_hours`/`taxonomy_mode` は指定しない——行が無い場合は DB 側の
    // DEFAULT（720 / 'open'）に任せる（マイグレーションを足さないため、この列にだけ
    // 値を書く UPSERT にする）。
    await this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, event_retention_days, updated_at)
      VALUES (${ctx.tenantId}, ${days}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET event_retention_days = EXCLUDED.event_retention_days, updated_at = now()
    `);
  }
}
