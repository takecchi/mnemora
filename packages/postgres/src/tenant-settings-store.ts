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
import { assertWellFormedCtx, assertWellFormedIdentifier } from "@mnemora/core";
import { assertHalfLifeRecallsFitsFloat4 } from "./half-life-float4.js";
import type { Db } from "./client.js";
import { omittingParams } from "./omit-params.js";

/**
 * `TenantSettingsStore` の Postgres 実装。
 *
 * `tenant_settings` に行が無いテナントは、DB の DEFAULT が効かない（行が作られたときにしか効かない）ので、
 * アプリケーション側で同じ値のフォールバック（`DEFAULT_HALF_LIFE_HOURS` など）を返す。
 */
export class PostgresTenantSettingsStore implements TenantSettingsStore {
  constructor(private readonly db: Db) {}

  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT default_half_life_hours FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
    if (result.rows.length === 0) {
      return DEFAULT_HALF_LIFE_HOURS;
    }
    const row = result.rows[0] as unknown as { default_half_life_hours: number };
    return row.default_half_life_hours;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT event_retention_days FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
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
    // 型の外の kind を、無期限として書かずに拒む。
    assertValidEventRetentionKind(retention.kind);
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
    }
    const days = retention.kind === "days" ? retention.days : null;
    // 他の列は指定しない（行が無ければ DB 側の DEFAULT に任せる）。
    await omittingParams(() =>
      this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, event_retention_days, updated_at)
      VALUES (${ctx.tenantId}, ${days}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET event_retention_days = EXCLUDED.event_retention_days, updated_at = now()
    `),
    );
  }

  /** `tenant_settings.decay_clock` の現在値。行が無ければ `DEFAULT_DECAY_CLOCK`。 */
  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT decay_clock FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
    if (result.rows.length === 0) {
      return DEFAULT_DECAY_CLOCK;
    }
    const row = result.rows[0] as unknown as { decay_clock: string };
    // CHECK 制約がこの列を限定しているので、通常経路では常に通る防御。
    assertValidDecayClock(row.decay_clock);
    return row.decay_clock;
  }

  /** 不正な値は `assertValidDecayClock`（core 共有）で拒む。他の列は指定しない（行が無ければ DB 側の DEFAULT に任せる）。 */
  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidDecayClock(clock);
    await omittingParams(() =>
      this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, decay_clock, updated_at)
      VALUES (${ctx.tenantId}, ${clock}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET decay_clock = EXCLUDED.decay_clock, updated_at = now()
    `),
    );
  }

  /** `tenant_settings.default_half_life_recalls` の現在値。行が無ければ `DEFAULT_HALF_LIFE_RECALLS`。 */
  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT default_half_life_recalls FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
    if (result.rows.length === 0) {
      return DEFAULT_HALF_LIFE_RECALLS;
    }
    const row = result.rows[0] as unknown as { default_half_life_recalls: number };
    return row.default_half_life_recalls;
  }

  /**
   * `tenant_settings.default_half_life_recalls` を設定する（UPSERT。ADR 0197）。不正な値は
   * `assertValidHalfLifeRecalls`（core 共有）で拒む。
   *
   * **この列は新規作成時の初期値としてのみ使われる。**既存 Memory の `half_life_recalls`/`decay_floor_seq` は
   * 1件も書き換えない。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidHalfLifeRecalls(recalls);
    // 列は `real`（float4）。収まらない値は DB の生の例外でなく明示の例外で断る。
    assertHalfLifeRecallsFitsFloat4("PostgresTenantSettingsStore", recalls);
    await omittingParams(() =>
      this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, default_half_life_recalls, updated_at)
      VALUES (${ctx.tenantId}, ${recalls}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET default_half_life_recalls = EXCLUDED.default_half_life_recalls, updated_at = now()
    `),
    );
  }

  /**
   * `tenant_activity.activity_seq` の現在値。行が無ければ `0`。**読み出し専用**で、進めるのは
   * `PostgresMemoryStore.createRecall`（`advanceActivityClock: true`）だけ。
   *
   * `bigint` 列は node-postgres が文字列で返すので `Number()` で変換する
   * （`Number.MAX_SAFE_INTEGER` を超える運用は想定しない）。
   */
  async getActivitySeq(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT activity_seq FROM tenant_activity WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
    if (result.rows.length === 0) {
      return 0;
    }
    const row = result.rows[0] as unknown as { activity_seq: string | number };
    return Number(row.activity_seq);
  }

  /**
   * `tenant_subject_activity` に、このテナントの行が1本でもあるか（ADR 0353）。`EXISTS` だけを見て
   * `activity_seq` の値は読まない。
   */
  async hasSubjectActivityCounters(ctx: Ctx): Promise<boolean> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT 1 FROM tenant_subject_activity WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
    return result.rows.length > 0;
  }

  /**
   * `tenant_subject_activity.activity_seq` を、渡した `subjectIds` についてまとめて読む（ADR 0353）。
   * 行が無い `subjectId` はキーを省略する（`readSubjectActivitySeqs`（core）が `0` へ倒す）。
   */
  async getSubjectActivitySeqs(ctx: Ctx, subjectIds: string[]): Promise<Record<string, number>> {
    assertWellFormedCtx(ctx);
    // `subjectIds` の各要素も識別子の検査の内側に置く（読む前に断る。ADR 0437）。
    subjectIds.forEach((id, i) => assertWellFormedIdentifier(id, `subjectIds[${i}]`));
    if (subjectIds.length === 0) {
      return {};
    }
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT subject_id, activity_seq FROM tenant_subject_activity
      WHERE tenant_id = ${ctx.tenantId} AND subject_id = ANY(${sql.param(subjectIds)}::text[])
    `),
    );
    const out = Object.create(null) as Record<string, number>;
    for (const row of result.rows as unknown as {
      subject_id: string;
      activity_seq: string | number;
    }[]) {
      out[row.subject_id] = Number(row.activity_seq);
    }
    return out;
  }

  /** `tenant_settings.taxonomy_mode` の現在値。行が無ければ `DEFAULT_TAXONOMY_MODE`。 */
  async getTaxonomyMode(ctx: Ctx): Promise<TaxonomyMode> {
    assertWellFormedCtx(ctx);
    const result = await omittingParams(() =>
      this.db.execute(sql`
      SELECT taxonomy_mode FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `),
    );
    if (result.rows.length === 0) {
      return DEFAULT_TAXONOMY_MODE;
    }
    const row = result.rows[0] as unknown as { taxonomy_mode: string };
    // CHECK 制約がこの列を限定しているので、通常経路では常に通る防御。
    assertValidTaxonomyMode(row.taxonomy_mode);
    return row.taxonomy_mode;
  }

  /** 不正な値は `assertValidTaxonomyMode`（core 共有）で拒む。他の列は指定しない（行が無ければ DB 側の DEFAULT に任せる）。 */
  async setTaxonomyMode(ctx: Ctx, mode: TaxonomyMode): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidTaxonomyMode(mode);
    await omittingParams(() =>
      this.db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, taxonomy_mode, updated_at)
      VALUES (${ctx.tenantId}, ${mode}, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET taxonomy_mode = EXCLUDED.taxonomy_mode, updated_at = now()
    `),
    );
  }

  /** `TenantSettingsStore.eraseTenant?` の実装（ADR 0383）。`tenant_id` が PK なので高々1行で、`reachedLimit` は常に `false`。 */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    if (opts.dryRun === true) {
      const result = await omittingParams(() =>
        this.db.execute(sql`
        SELECT 1 FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
      `),
      );
      return { deleted: result.rows.length, reachedLimit: false };
    }
    const result = await omittingParams(() =>
      this.db.execute(sql`
      DELETE FROM tenant_settings WHERE tenant_id = ${ctx.tenantId} RETURNING tenant_id
    `),
    );
    return { deleted: result.rows.length, reachedLimit: false };
  }
}
