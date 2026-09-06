import { describe, expect, it } from "vitest";
import { DEFAULT_HALF_LIFE_HOURS, EVENT_RETENTION_DAYS_INVALID_MESSAGE } from "@mnemora/core";
import type { Ctx, TenantSettingsStore } from "@mnemora/core";

/**
 * `setEventRetention` に不正な `days` を渡したときのメッセージが `EVENT_RETENTION_DAYS_INVALID_MESSAGE`
 * を含むことを見る。`TypeError` のような別種の失敗と区別するため、`.toThrow()` は引数なしで
 * 使わない（`memory-store-conformance.ts` の `NOT_FOUND_ERROR_MESSAGE` と同じ理由・同じ形）。
 */
const INVALID_DAYS_ERROR = new RegExp(EVENT_RETENTION_DAYS_INVALID_MESSAGE);

export interface TenantSettingsStoreConformanceOptions {
  name: string;
  createStore: () => TenantSettingsStore | Promise<TenantSettingsStore>;
  /**
   * テナントの `default_half_life_hours` を明示的に設定するためのフック。
   * 省略時はこのケースをスキップする（in-memory 実装は簡易な setter を持つ想定だが、
   * 将来 setter を持たない読み取り専用 adapter が来た場合にも壊れないようにする）。
   */
  setDefaultHalfLifeHours?: (ctx: Ctx, hours: number) => Promise<void> | void;
}

/**
 * `TenantSettingsStore` の適合テスト（roadmap.md 段階3、`decayFloorAt` 計算に使う
 * テナント既定値の読み出し契約。`getEventRetention`/`setEventRetention` は
 * `docs/decisions/0050-tenant-event-retention.md` で追加）。
 */
export function describeTenantSettingsStoreConformance(
  options: TenantSettingsStoreConformanceOptions,
): void {
  const { name, createStore, setDefaultHalfLifeHours } = options;

  describe(`TenantSettingsStore conformance (${name})`, () => {
    it("設定行が無いテナントには DEFAULT_HALF_LIFE_HOURS を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-unset-${Math.random()}` };
      expect(await store.getDefaultHalfLifeHours(ctx)).toBe(DEFAULT_HALF_LIFE_HOURS);
    });

    if (setDefaultHalfLifeHours) {
      it("設定済みのテナントにはその値を返す", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-custom-${Math.random()}` };
        await setDefaultHalfLifeHours(ctx, 24);
        expect(await store.getDefaultHalfLifeHours(ctx)).toBe(24);
      });
    }

    // -----------------------------------------------------------------
    // getEventRetention / setEventRetention（ADR 0050）
    //
    // ⚠ event_retention_days には3つの状態があり、これを2つに潰さないことが本節の芯。
    // | 状態                     | 意味                                   |
    // |--------------------------|----------------------------------------|
    // | 行が無い                 | まだ設定していない（既定は無期限）      |
    // | 行は在るが NULL          | 明示的に無期限と決めた                  |
    // | 数値                     | その日数                               |
    // -----------------------------------------------------------------

    it("設定行が無いテナントの event retention は unset", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-unset-${Math.random()}` };
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unset" });
    });

    if (setDefaultHalfLifeHours) {
      // ⭐ 3状態が潰れていないことの芯。half-life だけを設定して行を作ったテナントは、
      // event_retention_days が NULL のまま行が存在する状態になる ⟹ unlimited であって
      // unset ではない。in-memory 実装が half-life 用と retention 用を別々の Map に
      // 分けていた場合、この歯だけが unset を返して赤くなる（M2 参照）。
      it("⭐ half-life だけを設定した（行はできたが retention は未設定の）テナントは unlimited（unset と区別できる）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-half-life-only-${Math.random()}` };
        await setDefaultHalfLifeHours(ctx, 24);
        expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
      });
    }

    it("setEventRetention({ kind: 'days' }) は読み直しても同じ日数を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-days-${Math.random()}` };
      await store.setEventRetention(ctx, { kind: "days", days: 30 });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 30 });
    });

    it("setEventRetention({ kind: 'unlimited' }) は明示的に無期限へ戻す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-unlimited-${Math.random()}` };
      await store.setEventRetention(ctx, { kind: "days", days: 30 });
      await store.setEventRetention(ctx, { kind: "unlimited" });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
    });

    // ⚠ 非対称: 正しい値では成功することを、不正な値の検査と同じ歯の中で見る
    // （「常に失敗する」実装を緑にしないため）。
    it("setEventRetention の days は正の整数のみを受け付ける（0・負・非整数は拒み、正の整数は通す）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-validation-${Math.random()}` };

      await expect(store.setEventRetention(ctx, { kind: "days", days: 0 })).rejects.toThrow(
        INVALID_DAYS_ERROR,
      );
      await expect(store.setEventRetention(ctx, { kind: "days", days: -1 })).rejects.toThrow(
        INVALID_DAYS_ERROR,
      );
      await expect(store.setEventRetention(ctx, { kind: "days", days: 1.5 })).rejects.toThrow(
        INVALID_DAYS_ERROR,
      );

      // 延長も許す側に倒した（オーナーは「短縮できる口」と言ったが延長を禁じたとは
      // 言っていない）——短い日数の後に長い日数を設定しても成功する。
      await store.setEventRetention(ctx, { kind: "days", days: 7 });
      await store.setEventRetention(ctx, { kind: "days", days: 365 });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 365 });
    });
  });
}
