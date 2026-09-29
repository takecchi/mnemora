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
  EventRetention,
  EventRetentionSetting,
  TaxonomyMode,
  TenantSettingsStore,
} from "@mnemora/core";

/**
 * `TenantSettingsStore` のインメモリ・プレースホルダ実装（roadmap.md 段階3。
 * `getEventRetention`/`setEventRetention` は
 * `docs/decisions/0050-tenant-event-retention.md` で追加）。
 *
 * ⚠ `overrides = Map<string, number>`（half-life だけの値）ではなく、テナントごとに
 * 「行」を1つ持つ形にしてある。Postgres では `default_half_life_hours` を設定して
 * 行ができたテナントは `event_retention_days` が `NULL` ⟹ `{ kind: "unlimited" }` になる。
 * half-life 用と retention 用を別々の Map にすると、half-life だけ設定したテナントの
 * retention が「行が無い」（`{ kind: "unset" }`）のままになり、Postgres と食い違う
 * （ADR 0050 参照）。
 *
 * ⚠ **2026-09-29 追記（[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、
 * [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)）:**
 * 保持期間（`event_retention_days`）だけは、実際には上の「行」（`rows`）とは別の Map
 * （`eventRetentionDays`、下記）に持つ——`InMemoryMemoryStore.purgeExpiredEventsByRetention` と
 * 共有する必要があるため（`activitySeq`/`subjectActivitySeq` と同じ「同一プロセス内の参照共有」
 * の形）。**ただし、直前の段落の「half-life だけ設定したテナントも retention は unlimited に
 * なる」という Postgres との一致は崩していない**——`ensureRow`（下記）が、`rows` に新しい行を
 * 作るたびに、`eventRetentionDays` 側にも（まだ無ければ）`null` を立てて2つの Map を
 * 同期させる。
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

  /**
   * `activitySeqBacking`/`subjectActivitySeqBacking` が渡されなかったときのための、
   * このインスタンス専用の保持期間の Map（`eventRetentionDaysBacking` が渡されなかった
   * ときのフォールバック）。{@link InMemoryTenantSettingsStore.eventRetentionDays} 参照。
   */
  private readonly ownEventRetentionDays = new Map<string, number | null>();

  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと2・5・13
   * （Issue #305）: `getActivitySeq` が読む `tenant_activity` 相当のカウンタ。
   * `InMemoryMemoryStore.activitySeq`（`createRecall` が書く側）をそのまま渡すことで、
   * 書く側・読む側が同じ値を見る——`packages/core/src/__tests__/runtime-fakes.ts` の
   * `FakeTenantSettingsStore`/`FakeBackingStore` と同じ設計。**省略すると
   * `getActivitySeq` は常に `0` を返す**（`FakeTenantSettingsStore` と同じ規律）。
   *
   * [ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `subjectActivitySeqBacking` は `tenant_subject_activity` 相当——
   * `tenantId` → `subjectId` → `S_x` の2段の `Map`。`InMemoryMemoryStore.createRecall`
   * （`advanceActivityClock: { scope: "subject", subjectId }`）が書く側と共有する。
   *
   * Issue #1232 / [ADR 0354](../../../../docs/decisions/0354-atomic-event-retention-purge.md)
   * （Issue #338 の `subjectActivitySeqBacking` と同じ形の追加）: `eventRetentionDaysBacking` は
   * `tenant_settings.event_retention_days` 相当——`InMemoryMemoryStore.eventRetentionDays`
   * （`purgeExpiredEventsByRetention` が読む側）をそのまま渡すことで、`setEventRetention`
   * （書く側）と同じ値を見る。**省略すると、このインスタンス専用の Map
   * （`ownEventRetentionDays`）を使う**——`purgeExpiredEventsByRetention` を持たない
   * `MemoryStore` と組み合わせる場合など、共有が不要な既存の呼び出しをそのまま通す。
   */
  constructor(
    private readonly activitySeqBacking?: Map<string, number>,
    private readonly subjectActivitySeqBacking?: Map<string, Map<string, number>>,
    private readonly eventRetentionDaysBacking?: Map<string, number | null>,
  ) {}

  /** {@link InMemoryTenantSettingsStore.eventRetentionDaysBacking} が渡されていればそれを、無ければ自前の Map を返す。 */
  private get eventRetentionDays(): Map<string, number | null> {
    return this.eventRetentionDaysBacking ?? this.ownEventRetentionDays;
  }

  /**
   * 行が無ければ全列を既定値で作ってから返す（`setDefaultHalfLifeHours`/`setDecayClock` が
   * 共通して使う——UPSERT のたびに「他の列は DB 側の DEFAULT に任せる」という Postgres 実装
   * （`PostgresTenantSettingsStore`）と同じ挙動をここでも揃える）。
   *
   * ⚠ **`eventRetentionDays` はこの行の一部ではない**（上の `eventRetentionDays` getter が指す
   * 別の Map）——`InMemoryMemoryStore` と共有できるようにするため、保持期間だけを切り出してある
   * （クラス冒頭の doc コメント参照）。ただし「保持期間以外の設定を1つでも書くと
   * `event_retention_days` は `NULL`（`unlimited`）を持つ行ができる」という Postgres の
   * 挙動（`getEventRetention` の doc）はここでも揃える必要があるため、この行を新規に作るときは
   * `eventRetentionDays` 側にも（無ければ）`null` を立てる。
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
   *
   * 値域（ADR 0125）: `packages/postgres` は `tenant_settings_default_half_life_range` の
   * CHECK 制約でこれを強制する。この in-memory 実装にも同じ検査を置く——
   * ここで放置すると「本番では落ちる書き込みが手元では黙って成功する」（ADR 0047 と
   * 同じ理由。`isStrengthInRange` の使われ方を参照）。
   */
  setDefaultHalfLifeHours(tenantId: string, hours: number): void {
    if (!isHalfLifeHoursInRange(hours)) {
      throw new Error(`InMemoryTenantSettingsStore: halfLifeHours out of range (0, ∞): ${hours}`);
    }
    // `tenant_settings.default_half_life_hours` は Postgres の `real`（float4）列である。
    // float4 で溢れる値・0 でないのに 0 に丸まる値は、Postgres が
    // `"…" is out of range for type real` で拒む（【実測 2026-09-27】`1e39`・`Number.MAX_VALUE`・
    // `1e-46` は拒み、`1e-40`（非正規数に収まる）・`3.4e38` は受け付ける）。境界は
    // `createMemory` の `halfLifeHours` と同じく「`Math.fround(x)` が `Infinity` か 0 になるか」。
    const rounded = Math.fround(hours);
    if (!Number.isFinite(rounded) || rounded === 0) {
      throw new Error(
        `InMemoryTenantSettingsStore: halfLifeHours does not fit in a Postgres "real" (float4) column (got ${hours})`,
      );
    }
    this.ensureRow(tenantId).defaultHalfLifeHours = hours;
  }

  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    return this.rows.get(ctx.tenantId)?.defaultHalfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
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
    // Issue #1168: 型の外の kind を、無期限として書かずに拒む（decay_clock・taxonomy と同じ形）。
    assertValidEventRetentionKind(retention.kind);
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
      // Postgres の `event_retention_days` は `integer`（int4）列で、2^31 以上は `22003` で拒む。上の共有の検査は
      // 「正の整数」だけを見るので、列の範囲はここで写す（#1165 が半減期を `real` の範囲に揃えたのと同じ形）。
      if (retention.days > 2 ** 31 - 1) {
        throw new Error(
          `setEventRetention: days does not fit in a Postgres "integer" (int4) column (got ${retention.days})`,
        );
      }
    }
    const eventRetentionDays = retention.kind === "days" ? retention.days : null;
    this.ensureRow(ctx.tenantId);
    this.eventRetentionDays.set(ctx.tenantId, eventRetentionDays);
  }

  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと1・13
   * （Issue #305）: 行が無ければ `DEFAULT_DECAY_CLOCK`（`'wall'`）——`getDefaultHalfLifeHours`
   * と同じ規律。
   */
  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    return this.rows.get(ctx.tenantId)?.decayClock ?? DEFAULT_DECAY_CLOCK;
  }

  /**
   * 不正な値は `assertValidDecayClock`（core 共有、`PostgresTenantSettingsStore.setDecayClock`
   * と同じ検証関数）で拒む——実装ごとに条件式を書き直さない。
   */
  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertValidDecayClock(clock);
    this.ensureRow(ctx.tenantId).decayClock = clock;
  }

  /**
   * ADR 0165 決めたこと3・13: 行が無ければ `DEFAULT_HALF_LIFE_RECALLS`（720）——
   * `getDefaultHalfLifeHours` と同じ規律。
   */
  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    return this.rows.get(ctx.tenantId)?.defaultHalfLifeRecalls ?? DEFAULT_HALF_LIFE_RECALLS;
  }

  /**
   * [ADR 0197](../../../../docs/decisions/0197-set-default-half-life-recalls.md):
   * `TenantSettingsStore` interface の本番の書き込み口。`setDecayClock`
   * （このファイル上）と同じ規律——不正な値は `assertValidHalfLifeRecalls`（core 共有、
   * `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls` と同じ検証関数）で拒む。
   *
   * ⚠ **これ以前はここに `setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void`
   * というテスト専用フックが在った**（`setDefaultHalfLifeHours` と対になる形。値域検査は
   * 同じ `isHalfLifeRecallsInRange`）。ADR 0197 が `TenantSettingsStore` interface に
   * 同名の本番メソッドを足したため名前が衝突し、**「本番の口だけを残す」を選んで削除した**
   * （ADR 0197「決めたこと」参照。`setDefaultHalfLifeHours` を削除しなかったのは、
   * `setDefaultHalfLifeHours` には対応する本番メソッドが無く、テスト用フックが唯一の
   * 設定手段のままだから——非対称ではなく、対称にする理由が無くなっただけである）。
   * 旧フックを直接呼んでいた外部コードがあれば、この呼び出しは
   * `store.setDefaultHalfLifeRecalls({ tenantId }, recalls)`（`Promise` を返す）に
   * 書き換える必要がある——**破壊的変更**（testkit の公開型）。
   *
   * ⚠ この列は新規作成時の初期値としてのみ使われる——既存 Memory の
   * `halfLifeRecalls`/`decayFloorSeq` はこの呼び出しでは変わらない
   * （`InMemoryMemoryStore` 側は本 ADR の対象外）。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertValidHalfLifeRecalls(recalls);
    // `assertValidHalfLifeRecalls`（core 共有）の値域は `(0, ∞)`——JS の float64 では
    // 有限だが、`tenant_settings.default_half_life_recalls` は Postgres の `real`
    // （IEEE 754 単精度・float4）列であり、値域は約 `±3.4028235e38` までしか無い
    // （`migrations/0015_decay_activity_clock.sql` の
    // `CHECK (default_half_life_recalls > 0 AND default_half_life_recalls < 'Infinity'::real)`）。
    // `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls` へ float4 の範囲を超える値
    // （例: `1e300`）を渡すと、値が `real` へ変換される際に `Infinity` へ丸まり、
    // 上の CHECK 制約に引っかかって例外を投げる（実測: 本物の Postgres 17 で確認）。
    // `Math.fround` は JS の number を IEEE 754 単精度（float4 と同じビット幅）へ丸める
    // 標準関数であり、その丸めで `Infinity` になるかどうかは Postgres の `real` への
    // 変換が overflow するかどうかと**ビット単位で一致する**（実測: 境界値
    // `3.4028235677973362e+38`（有限）と `3.4028235677973366e+38`（overflow）の両方を
    // `psql` で確認し、`Math.fround` の有限/無限の境界と完全に一致することを確認した）。
    //
    // 下側も同じ: 0 でない値が float4 で 0 に丸まる（例: `1e-46`）と、Postgres では 0 になって
    // 上の CHECK（`> 0`）に抵触し例外になる（【実測 2026-09-27】）。`1e-40`（非正規数に収まる）は
    // 受け付ける。境界は「`Math.fround(x)` が 0 になるか」（`createMemory` の下側と同じ）。
    const rounded = Math.fround(recalls);
    if (!Number.isFinite(rounded) || rounded === 0) {
      throw new Error(
        `setDefaultHalfLifeRecalls: recalls does not fit in a Postgres "real" (float4) column (got ${recalls})`,
      );
    }
    this.ensureRow(ctx.tenantId).defaultHalfLifeRecalls = recalls;
  }

  /**
   * ADR 0165 決めたこと2・5・13: `activitySeqBacking`（コンストラクタで渡された、
   * `InMemoryMemoryStore.activitySeq` と共有する Map）を読む。**読み出し専用**——
   * 進めるのは `InMemoryMemoryStore.createRecall`（`advanceActivityClock: true`）だけ。
   * 渡されていなければ常に `0`（`FakeTenantSettingsStore` と同じ規律）。
   */
  async getActivitySeq(ctx: Ctx): Promise<number> {
    return this.activitySeqBacking?.get(ctx.tenantId) ?? 0;
  }

  /**
   * [ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `subjectActivitySeqBacking` に、このテナントの行が1本でもあるか。
   * `subjectActivitySeqBacking` 自体が渡されていなければ常に `false`
   * （`getActivitySeq` が backing 無しで常に `0` を返すのと同じ規律）。
   */
  async hasSubjectActivityCounters(ctx: Ctx): Promise<boolean> {
    const bySubject = this.subjectActivitySeqBacking?.get(ctx.tenantId);
    return bySubject !== undefined && bySubject.size > 0;
  }

  /**
   * [ADR 0353](../../../../docs/decisions/0353-activity-counting-per-call.md)
   * （Issue #338）: `subjectActivitySeqBacking` から、渡された `subjectIds` ぶんを
   * まとめて読む。行が無い `subjectId` はキーを省略する（`readSubjectActivitySeqs`
   * （core）が `0` へ倒す）。
   */
  async getSubjectActivitySeqs(ctx: Ctx, subjectIds: string[]): Promise<Record<string, number>> {
    const bySubject = this.subjectActivitySeqBacking?.get(ctx.tenantId);
    const out: Record<string, number> = {};
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

  /**
   * Issue #201 / ADR 0318: 行が無ければ `DEFAULT_TAXONOMY_MODE`（`'open'`）——
   * `getDecayClock` と同じ規律。
   */
  async getTaxonomyMode(ctx: Ctx): Promise<TaxonomyMode> {
    return this.rows.get(ctx.tenantId)?.taxonomyMode ?? DEFAULT_TAXONOMY_MODE;
  }

  /**
   * 不正な値は `assertValidTaxonomyMode`（core 共有、`PostgresTenantSettingsStore
   * .setTaxonomyMode` と同じ検証関数）で拒む——`setDecayClock` と同じ形。
   */
  async setTaxonomyMode(ctx: Ctx, mode: TaxonomyMode): Promise<void> {
    assertValidTaxonomyMode(mode);
    this.ensureRow(ctx.tenantId).taxonomyMode = mode;
  }
}
