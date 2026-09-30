import { sql } from "drizzle-orm";
import {
  assertValidDecayClock,
  assertValidEventRetentionDays,
  assertValidEventRetentionKind,
  assertValidHalfLifeRecalls,
  assertValidTaxonomyMode,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_HOURS,
  DEFAULT_HALF_LIFE_RECALLS,
  DEFAULT_TAXONOMY_MODE,
} from "@mnemora/core";
import type {
  Ctx,
  DecayClock,
  EraseTenantResult,
  EraseTenantStoreOptions,
  EventRetention,
  EventRetentionSetting,
  TaxonomyMode,
  TenantSettingsStore,
} from "@mnemora/core";
import { assertWellFormedCtx } from "@mnemora/core";
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
    assertWellFormedCtx(ctx);
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
    assertWellFormedCtx(ctx);
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
    assertWellFormedCtx(ctx);
    // Issue #1168: 型の外の kind を、無期限として書かずに拒む（decay_clock・taxonomy と同じ形）。
    assertValidEventRetentionKind(retention.kind);
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

  /**
   * ADR 0165 決めたこと1・13: `tenant_settings.decay_clock` の現在値。行が無ければ
   * `DEFAULT_DECAY_CLOCK`（`'wall'`）——`getDefaultHalfLifeHours` と同じ規律。
   */
  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT decay_clock FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    if (result.rows.length === 0) {
      return DEFAULT_DECAY_CLOCK;
    }
    const row = result.rows[0] as unknown as { decay_clock: string };
    // DB 側の CHECK 制約（migrations/0015）がこの列を3値に限定しているため、ここでの
    // asserts は「読み直した値が予期しない値だった」ことを検出する防御であって、
    // 通常経路では常に通る。
    assertValidDecayClock(row.decay_clock);
    return row.decay_clock;
  }

  /**
   * ADR 0165 決めたこと13: 不正な値は `assertValidDecayClock`（core 共有）で拒む。
   * `event_retention_days`/`default_half_life_hours`/`default_half_life_recalls` は
   * 指定しない——行が無い場合は DB 側の DEFAULT に任せる（`setEventRetention` と同じ形）。
   */
  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidDecayClock(clock);
    await this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, decay_clock, updated_at)
      VALUES (${ctx.tenantId}, ${clock}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET decay_clock = EXCLUDED.decay_clock, updated_at = now()
    `);
  }

  /**
   * ADR 0165 決めたこと3・13: `tenant_settings.default_half_life_recalls` の現在値。
   * 行が無ければ `DEFAULT_HALF_LIFE_RECALLS`（720）——`getDefaultHalfLifeHours` と同じ規律。
   */
  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT default_half_life_recalls FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    if (result.rows.length === 0) {
      return DEFAULT_HALF_LIFE_RECALLS;
    }
    const row = result.rows[0] as unknown as { default_half_life_recalls: number };
    return row.default_half_life_recalls;
  }

  /**
   * [ADR 0197](../../../docs/decisions/0197-set-default-half-life-recalls.md):
   * `tenant_settings.default_half_life_recalls` を設定する（UPSERT。行が無ければ作る）。
   * `setDecayClock`（上）と**完全に同じ形**——不正な値は `assertValidHalfLifeRecalls`
   * （core 共有）で拒む。`event_retention_days`/`default_half_life_hours`/`decay_clock` は
   * 指定しない——行が無い場合は DB 側の DEFAULT に任せる（`setDecayClock`/`setEventRetention`
   * と同じ形）。
   *
   * ⚠ **この列は新規作成時の初期値としてのみ使われる**（migrations/0015 の doc・
   * `getDefaultHalfLifeRecalls` の doc 参照）。この呼び出しは既存 Memory の
   * `half_life_recalls`/`decay_floor_seq` を1件も書き換えない。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidHalfLifeRecalls(recalls);
    await this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, default_half_life_recalls, updated_at)
      VALUES (${ctx.tenantId}, ${recalls}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET default_half_life_recalls = EXCLUDED.default_half_life_recalls, updated_at = now()
    `);
  }

  /**
   * ADR 0165 決めたこと2・5・13: `tenant_activity.activity_seq` の現在値。行が無ければ
   * `0`（`decay_clock` を一度も `'wall'` 以外に設定していないテナントの既定）。
   * **読み出し専用**——進めるのは `PostgresMemoryStore.createRecall`
   * （`advanceActivityClock: true`）だけである。
   *
   * `activity_seq` は `bigint` 列。node-postgres は `bigint`（OID 20）を精度損失を避けるため
   * 文字列で返す——`Number()` で変換する（`tenant_activity.activity_seq` が
   * `Number.MAX_SAFE_INTEGER` を超える運用は想定していない。recall 呼び出し回数の
   * カウンタであり、そこまで到達する前に他の限界に当たる）。
   */
  async getActivitySeq(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT activity_seq FROM tenant_activity WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    if (result.rows.length === 0) {
      return 0;
    }
    const row = result.rows[0] as unknown as { activity_seq: string | number };
    return Number(row.activity_seq);
  }

  /**
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `tenant_subject_activity` に、このテナントの行が1本でもあるか。
   * **`EXISTS` だけを見る**——`activity_seq` の値そのものは読まない（呼び出し側は
   * `getSubjectActivitySeqs` を別途呼ぶ）。主キーの先頭列（`tenant_id`）で引けるので
   * 追加の索引は要らない。
   */
  async hasSubjectActivityCounters(ctx: Ctx): Promise<boolean> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT 1 FROM tenant_subject_activity WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    return result.rows.length > 0;
  }

  /**
   * [ADR 0353](../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `tenant_subject_activity.activity_seq`（`S_x`）を、渡した
   * `subjectIds` についてまとめて読む。行が無い `subjectId` はキーを省略する
   * （`readSubjectActivitySeqs`（core）が `0` へ倒す）。
   *
   * `activity_seq` は `bigint` 列——`getActivitySeq` と同じ理由で `Number()` に変換する。
   */
  async getSubjectActivitySeqs(ctx: Ctx, subjectIds: string[]): Promise<Record<string, number>> {
    assertWellFormedCtx(ctx);
    if (subjectIds.length === 0) {
      return {};
    }
    const result = await this.db.execute(sql`
      SELECT subject_id, activity_seq FROM tenant_subject_activity
      WHERE tenant_id = ${ctx.tenantId} AND subject_id = ANY(${sql.param(subjectIds)}::text[])
    `);
    const out: Record<string, number> = {};
    for (const row of result.rows as unknown as {
      subject_id: string;
      activity_seq: string | number;
    }[]) {
      out[row.subject_id] = Number(row.activity_seq);
    }
    return out;
  }

  /**
   * Issue #201 / ADR 0318: `tenant_settings.taxonomy_mode` の現在値。行が無ければ
   * `DEFAULT_TAXONOMY_MODE`（`'open'`）——`getDecayClock` と同じ規律。
   */
  async getTaxonomyMode(ctx: Ctx): Promise<TaxonomyMode> {
    assertWellFormedCtx(ctx);
    const result = await this.db.execute(sql`
      SELECT taxonomy_mode FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `);
    if (result.rows.length === 0) {
      return DEFAULT_TAXONOMY_MODE;
    }
    const row = result.rows[0] as unknown as { taxonomy_mode: string };
    // DB 側の CHECK 制約（migrations/0001_init.sql）がこの列を2値に限定しているため、
    // ここでの assert は「読み直した値が予期しない値だった」ことを検出する防御であって、
    // 通常経路では常に通る（`getDecayClock` と同じ形）。
    assertValidTaxonomyMode(row.taxonomy_mode);
    return row.taxonomy_mode;
  }

  /**
   * Issue #201 / ADR 0318: 不正な値は `assertValidTaxonomyMode`（core 共有）で拒む。
   * `event_retention_days`/`default_half_life_hours`/`decay_clock`/
   * `default_half_life_recalls` は指定しない——行が無い場合は DB 側の DEFAULT に任せる
   * （`setDecayClock` と同じ形）。
   */
  async setTaxonomyMode(ctx: Ctx, mode: TaxonomyMode): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidTaxonomyMode(mode);
    await this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, taxonomy_mode, updated_at)
      VALUES (${ctx.tenantId}, ${mode}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET taxonomy_mode = EXCLUDED.taxonomy_mode, updated_at = now()
    `);
  }

  /**
   * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md):
   * `TenantSettingsStore.eraseTenant?` の実装。`tenant_settings` は `tenant_id` が
   * PK なので高々1行——`reachedLimit` は常に `false`（interface doc 参照）。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    if (opts.dryRun === true) {
      const result = await this.db.execute(sql`
        SELECT 1 FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
      `);
      return { deleted: result.rows.length, reachedLimit: false };
    }
    const result = await this.db.execute(sql`
      DELETE FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} RETURNING tenant_id
    `);
    return { deleted: result.rows.length, reachedLimit: false };
  }
}
