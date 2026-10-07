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
  isHalfLifeHoursInRange,
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
import { toFloat4Readback } from "./float4.js";

/**
 * `TenantSettingsStore` のインメモリ・プレースホルダ実装。
 *
 * 設定は `overrides: Map<string, number>` ではなく、テナントごとに「行」を1つ持つ: Postgres では設定して行ができたテナントは
 * `event_retention_days` が `NULL`（`{ kind: "unlimited" }`）になるので、別々の Map にすると half-life だけ設定したテナントの
 * retention が `{ kind: "unset" }` のままになり、食い違う。
 * 保持期間だけは `InMemoryMemoryStore.purgeExpiredEventsByRetention` と共有するため `eventRetentionDays` の Map に持つ。
 * `ensureRow` が行を作るたびに、そちらにも（無ければ）`null` を立てて揃える。
 */
export class InMemoryTenantSettingsStore implements TenantSettingsStore {
  private readonly rows = new Map<
    string,
    {
      defaultHalfLifeHours: number;
      decayClock: DecayClock;
      defaultHalfLifeRecalls: number;
      taxonomyMode: TaxonomyMode;
    }
  >();

  /** `eventRetentionDaysBacking` が渡されなかったときの、このインスタンス専用の保持期間の Map。 */
  private readonly ownEventRetentionDays = new Map<string, number | null>();

  /**
   * `activitySeqBacking`・`subjectActivitySeqBacking`・`eventRetentionDaysBacking` は、`InMemoryMemoryStore` の同名の Map を渡すと、
   * 書く側・読む側が同じ値を見る。省略すると `getActivitySeq` は常に `0`、保持期間はこのインスタンス専用の Map を使う。
   * `subjectActivitySeqBacking` は `tenantId` → `subjectId` → `S_x` の2段。
   */
  constructor(
    private readonly activitySeqBacking?: Map<string, number>,
    private readonly subjectActivitySeqBacking?: Map<string, Map<string, number>>,
    private readonly eventRetentionDaysBacking?: Map<string, number | null>,
  ) {}

  private get eventRetentionDays(): Map<string, number | null> {
    return this.eventRetentionDaysBacking ?? this.ownEventRetentionDays;
  }

  /**
   * 行が無ければ全列を既定値で作ってから返す（他の列は DB の DEFAULT に任せる Postgres と揃える）。
   * `eventRetentionDays` はこの行の一部ではない（共有のため別の Map）が、行を新規に作るときは、そちらにも（無ければ）`null` を立てる。
   */
  private ensureRow(tenantId: string): {
    defaultHalfLifeHours: number;
    decayClock: DecayClock;
    defaultHalfLifeRecalls: number;
    taxonomyMode: TaxonomyMode;
  } {
    let row = this.rows.get(tenantId);
    if (!row) {
      row = {
        defaultHalfLifeHours: DEFAULT_HALF_LIFE_HOURS,
        decayClock: DEFAULT_DECAY_CLOCK,
        defaultHalfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
        taxonomyMode: DEFAULT_TAXONOMY_MODE,
      };
      this.rows.set(tenantId, row);
    }
    if (!this.eventRetentionDays.has(tenantId)) {
      this.eventRetentionDays.set(tenantId, null);
    }
    return row;
  }

  /**
   * 設定行を作る（テスト用フック）。既存の行があれば half-life だけ上書きする。
   * 値域は Postgres の CHECK 制約と同じ検査を置く: 放置すると、本番では落ちる書き込みが手元では黙って成功する。
   */
  setDefaultHalfLifeHours(tenantId: string, hours: number): void {
    if (!isHalfLifeHoursInRange(hours)) {
      throw new Error(`InMemoryTenantSettingsStore: halfLifeHours out of range (0, ∞): ${hours}`);
    }
    // `real`（float4）列。`Math.fround(x)` が `Infinity` か 0 になる値は Postgres が拒む（`createMemory` の `halfLifeHours` と同じ境界）。
    const rounded = Math.fround(hours);
    if (!Number.isFinite(rounded) || rounded === 0) {
      throw new Error(
        `InMemoryTenantSettingsStore: halfLifeHours does not fit in a Postgres "real" (float4) column (got ${hours})`,
      );
    }
    // float4 の列なので、Postgres が読み戻す値で持つ。
    this.ensureRow(tenantId).defaultHalfLifeHours = toFloat4Readback(hours);
  }

  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    return this.rows.get(ctx.tenantId)?.defaultHalfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    assertWellFormedCtx(ctx);
    if (!this.eventRetentionDays.has(ctx.tenantId)) {
      return { kind: "unset" };
    }
    const days = this.eventRetentionDays.get(ctx.tenantId)!;
    if (days === null) {
      return { kind: "unlimited" };
    }
    return { kind: "days", days };
  }

  async setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    assertWellFormedCtx(ctx);
    // 型の外の kind を、無期限として書かずに拒む。
    assertValidEventRetentionKind(retention.kind);
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
    }
    const eventRetentionDays = retention.kind === "days" ? retention.days : null;
    this.ensureRow(ctx.tenantId);
    this.eventRetentionDays.set(ctx.tenantId, eventRetentionDays);
  }

  /** 行が無ければ `DEFAULT_DECAY_CLOCK`（`'wall'`）。 */
  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    assertWellFormedCtx(ctx);
    return this.rows.get(ctx.tenantId)?.decayClock ?? DEFAULT_DECAY_CLOCK;
  }

  /** 不正な値は core 共有の `assertValidDecayClock` で拒む（実装ごとに条件式を書き直さない）。 */
  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidDecayClock(clock);
    this.ensureRow(ctx.tenantId).decayClock = clock;
  }

  /** 行が無ければ `DEFAULT_HALF_LIFE_RECALLS`（720）。 */
  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    return this.rows.get(ctx.tenantId)?.defaultHalfLifeRecalls ?? DEFAULT_HALF_LIFE_RECALLS;
  }

  /**
   * 不正な値は core 共有の `assertValidHalfLifeRecalls` で拒む。この値は新規作成時の初期値としてのみ使われ、
   * 既存 Memory の `halfLifeRecalls`/`decayFloorSeq` は変わらない。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidHalfLifeRecalls(recalls);
    // `tenant_settings.default_half_life_recalls` は `real`（float4）列で、`Math.fround(x)` が `Infinity` か 0 になる値は
    // Postgres の CHECK 制約（`> 0` と `< 'Infinity'::real`）に抵触する。`(0, ∞)` の core の検査だけでは足りない。
    const rounded = Math.fround(recalls);
    if (!Number.isFinite(rounded) || rounded === 0) {
      throw new Error(
        `setDefaultHalfLifeRecalls: recalls does not fit in a Postgres "real" (float4) column (got ${recalls})`,
      );
    }
    // float4 の列なので、Postgres が読み戻す値で持つ。
    this.ensureRow(ctx.tenantId).defaultHalfLifeRecalls = toFloat4Readback(recalls);
  }

  /** `activitySeqBacking` を読む。読み出し専用で、進めるのは `InMemoryMemoryStore.createRecall` だけ。渡されていなければ常に `0`。 */
  async getActivitySeq(ctx: Ctx): Promise<number> {
    assertWellFormedCtx(ctx);
    return this.activitySeqBacking?.get(ctx.tenantId) ?? 0;
  }

  /** `subjectActivitySeqBacking` に、このテナントの行が1本でもあるか。渡されていなければ常に `false`。 */
  async hasSubjectActivityCounters(ctx: Ctx): Promise<boolean> {
    assertWellFormedCtx(ctx);
    const bySubject = this.subjectActivitySeqBacking?.get(ctx.tenantId);
    return bySubject !== undefined && bySubject.size > 0;
  }

  /** `subjectIds` ぶんをまとめて読む。行が無い `subjectId` はキーを省略する。 */
  async getSubjectActivitySeqs(ctx: Ctx, subjectIds: string[]): Promise<Record<string, number>> {
    assertWellFormedCtx(ctx);
    // 各要素も識別子の検査の内側に置く（読む前に断る。NUL もここで断る）。
    subjectIds.forEach((id, i) => assertWellFormedIdentifier(id, `subjectIds[${i}]`));
    const bySubject = this.subjectActivitySeqBacking?.get(ctx.tenantId);
    const out = Object.create(null) as Record<string, number>;
    if (bySubject === undefined) {
      return out;
    }
    for (const id of subjectIds) {
      const value = bySubject.get(id);
      if (value !== undefined) {
        out[id] = value;
      }
    }
    return out;
  }

  /** 行が無ければ `DEFAULT_TAXONOMY_MODE`（`'open'`）。 */
  async getTaxonomyMode(ctx: Ctx): Promise<TaxonomyMode> {
    assertWellFormedCtx(ctx);
    return this.rows.get(ctx.tenantId)?.taxonomyMode ?? DEFAULT_TAXONOMY_MODE;
  }

  /** 不正な値は core 共有の `assertValidTaxonomyMode` で拒む。 */
  async setTaxonomyMode(ctx: Ctx, mode: TaxonomyMode): Promise<void> {
    assertWellFormedCtx(ctx);
    assertValidTaxonomyMode(mode);
    this.ensureRow(ctx.tenantId).taxonomyMode = mode;
  }

  /** `rows`/`eventRetentionDays` の該当テナントの行を消す。高々1行なので `reachedLimit` は常に `false`。 */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    const existed = this.rows.has(ctx.tenantId) || this.eventRetentionDays.has(ctx.tenantId);
    if (!opts.dryRun) {
      this.rows.delete(ctx.tenantId);
      this.eventRetentionDays.delete(ctx.tenantId);
    }
    return { deleted: existed ? 1 : 0, reachedLimit: false };
  }
}
