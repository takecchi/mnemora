import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  assertValidDecayClock,
  assertValidTaxonomyMode,
  DECAY_CLOCK_INVALID_MESSAGE,
  DECAY_CLOCK_UNSUPPORTED_MESSAGE,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_RECALLS,
  DEFAULT_TAXONOMY_MODE,
  isHalfLifeRecallsInRange,
  readActivitySeq,
  readDecayClock,
  readDefaultHalfLifeRecalls,
  readHasSubjectActivityCounters,
  readSubjectActivitySeq,
  readSubjectActivitySeqs,
  readTaxonomyMode,
  TAXONOMY_MODE_INVALID_MESSAGE,
  TAXONOMY_MODE_UNSUPPORTED_MESSAGE,
  writeDecayClock,
  writeTaxonomyMode,
} from "../interfaces/tenant-settings-store.js";
import type {
  DecayClock,
  EventRetention,
  EventRetentionSetting,
  TaxonomyMode,
  TenantSettingsStore,
} from "../interfaces/tenant-settings-store.js";

/**
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと13の歯。
 *
 * `readDecayClock`/`readActivitySeq`/`readDefaultHalfLifeRecalls`/`writeDecayClock` は
 * `packages/core` が `TenantSettingsStore` の4つの省略可能メソッドへ読み書きする
 * **唯一の通り道**である。フォールバックの規律はここにしか無い——呼び出し側
 * （`runtime.ts`/`recall-runtime.ts`）にこの分岐を散らさないための1箇所であることを
 * この歯で固定する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

/** 4メソッドをすべて省略した最小実装（外部の未対応 adapter を模す）。 */
function minimalStore(): TenantSettingsStore {
  return {
    async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
      return 720;
    },
    async getEventRetention(_ctx: Ctx): Promise<EventRetention> {
      return { kind: "unset" };
    },
    async setEventRetention(_ctx: Ctx, _retention: EventRetentionSetting): Promise<void> {},
  };
}

/** 4メソッドを実装しているが、呼ぶと必ず投げる実装(「未実装」ではなく「実行時エラー」を模す)。 */
function throwingStore(message: string): TenantSettingsStore {
  return {
    ...minimalStore(),
    async getDecayClock(_ctx: Ctx): Promise<DecayClock> {
      throw new Error(message);
    },
    async setDecayClock(_ctx: Ctx, _clock: DecayClock): Promise<void> {
      throw new Error(message);
    },
    async getDefaultHalfLifeRecalls(_ctx: Ctx): Promise<number> {
      throw new Error(message);
    },
    async getActivitySeq(_ctx: Ctx): Promise<number> {
      throw new Error(message);
    },
    async getTaxonomyMode(_ctx: Ctx): Promise<TaxonomyMode> {
      throw new Error(message);
    },
    async setTaxonomyMode(_ctx: Ctx, _mode: TaxonomyMode): Promise<void> {
      throw new Error(message);
    },
  };
}

describe("readDecayClock", () => {
  it("getDecayClock を持たない adapter では DEFAULT_DECAY_CLOCK（'wall'）へ倒す", async () => {
    const clock = await readDecayClock(minimalStore(), ctx);
    expect(clock).toBe(DEFAULT_DECAY_CLOCK);
    expect(clock).toBe("wall");
  });

  it("getDecayClock が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getDecayClock(_ctx: Ctx): Promise<DecayClock> {
        return "activity";
      },
    };
    expect(await readDecayClock(store, ctx)).toBe("activity");
  });

  it("getDecayClock が在って投げた場合は、既定へ倒さず素通しで投げる（「未実装」と「失敗」を混ぜない）", async () => {
    await expect(readDecayClock(throwingStore("db down"), ctx)).rejects.toThrow("db down");
  });
});

describe("readActivitySeq", () => {
  it("getActivitySeq を持たない adapter では 0 へ倒す", async () => {
    expect(await readActivitySeq(minimalStore(), ctx)).toBe(0);
  });

  it("getActivitySeq が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getActivitySeq(_ctx: Ctx): Promise<number> {
        return 42;
      },
    };
    expect(await readActivitySeq(store, ctx)).toBe(42);
  });

  it("getActivitySeq が在って投げた場合は素通しで投げる", async () => {
    await expect(readActivitySeq(throwingStore("db down"), ctx)).rejects.toThrow("db down");
  });
});

describe("readHasSubjectActivityCounters", () => {
  it("hasSubjectActivityCounters を持たない adapter では false へ倒す", async () => {
    expect(await readHasSubjectActivityCounters(minimalStore(), ctx)).toBe(false);
  });

  it("hasSubjectActivityCounters が在れば、true も false もそのまま返す", async () => {
    const withValue = (value: boolean): TenantSettingsStore => ({
      ...minimalStore(),
      async hasSubjectActivityCounters(_ctx: Ctx): Promise<boolean> {
        return value;
      },
    });
    expect(await readHasSubjectActivityCounters(withValue(true), ctx)).toBe(true);
    expect(await readHasSubjectActivityCounters(withValue(false), ctx)).toBe(false);
  });
});

describe("readSubjectActivitySeqs / readSubjectActivitySeq", () => {
  /** 行が在る subject だけを返し、行が無い subject はキーを省略する adapter。 */
  function storeWithRows(rows: Record<string, number>): TenantSettingsStore {
    return {
      ...minimalStore(),
      async getSubjectActivitySeqs(
        _ctx: Ctx,
        subjectIds: string[],
      ): Promise<Record<string, number>> {
        const out: Record<string, number> = {};
        for (const id of subjectIds) {
          if (id in rows) out[id] = rows[id]!;
        }
        return out;
      },
    };
  }

  it("getSubjectActivitySeqs を持たない adapter では、渡した subjectId すべてを 0 にして返す", async () => {
    expect(await readSubjectActivitySeqs(minimalStore(), ctx, ["s1", "s2"])).toEqual({
      s1: 0,
      s2: 0,
    });
    expect(await readSubjectActivitySeq(minimalStore(), ctx, "s1")).toBe(0);
  });

  it("subjectIds が空なら {}（adapter を呼ばない）", async () => {
    let called = false;
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getSubjectActivitySeqs(): Promise<Record<string, number>> {
        called = true;
        return {};
      },
    };
    expect(await readSubjectActivitySeqs(store, ctx, [])).toEqual({});
    expect(called).toBe(false);
  });

  it("行が無い subjectId（adapter がキーを省略）は 0 に倒し、行が在るものはその値を返す", async () => {
    const store = storeWithRows({ s1: 7 });
    expect(await readSubjectActivitySeqs(store, ctx, ["s1", "s2"])).toEqual({ s1: 7, s2: 0 });
  });

  it("adapter が渡していない余計なキーを返しても、結果には渡した subjectId だけが入る", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getSubjectActivitySeqs(): Promise<Record<string, number>> {
        return { s1: 7, other: 9 };
      },
    };
    expect(await readSubjectActivitySeqs(store, ctx, ["s1"])).toEqual({ s1: 7 });
  });

  it("単数版: 行が在れば値、行が無ければ 0", async () => {
    const store = storeWithRows({ s1: 7 });
    expect(await readSubjectActivitySeq(store, ctx, "s1")).toBe(7);
    expect(await readSubjectActivitySeq(store, ctx, "missing")).toBe(0);
  });

  it("getSubjectActivitySeqs が在って投げた場合は素通しで投げる", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getSubjectActivitySeqs(): Promise<Record<string, number>> {
        throw new Error("db down");
      },
    };
    await expect(readSubjectActivitySeqs(store, ctx, ["s1"])).rejects.toThrow("db down");
  });
});

describe("readDefaultHalfLifeRecalls", () => {
  it("getDefaultHalfLifeRecalls を持たない adapter では DEFAULT_HALF_LIFE_RECALLS へ倒す", async () => {
    const value = await readDefaultHalfLifeRecalls(minimalStore(), ctx);
    expect(value).toBe(DEFAULT_HALF_LIFE_RECALLS);
    expect(value).toBe(720);
  });

  it("getDefaultHalfLifeRecalls が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getDefaultHalfLifeRecalls(_ctx: Ctx): Promise<number> {
        return 100;
      },
    };
    expect(await readDefaultHalfLifeRecalls(store, ctx)).toBe(100);
  });

  it("getDefaultHalfLifeRecalls が在って投げた場合は素通しで投げる", async () => {
    await expect(readDefaultHalfLifeRecalls(throwingStore("db down"), ctx)).rejects.toThrow(
      "db down",
    );
  });
});

describe("writeDecayClock", () => {
  it("setDecayClock を持たない adapter では、既定へ倒さず DECAY_CLOCK_UNSUPPORTED_MESSAGE を含む Error で明示的に失敗する", async () => {
    await expect(writeDecayClock(minimalStore(), ctx, "activity")).rejects.toThrow(
      DECAY_CLOCK_UNSUPPORTED_MESSAGE,
    );
  });

  it("setDecayClock が在り成功すれば、そのまま委譲する", async () => {
    const written: DecayClock[] = [];
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async setDecayClock(_ctx: Ctx, clock: DecayClock): Promise<void> {
        written.push(clock);
      },
    };
    await writeDecayClock(store, ctx, "either");
    expect(written).toEqual(["either"]);
  });

  it("setDecayClock が在って投げた場合は素通しで投げる", async () => {
    await expect(writeDecayClock(throwingStore("db down"), ctx, "activity")).rejects.toThrow(
      "db down",
    );
  });
});

describe("assertValidDecayClock", () => {
  it("'wall'/'activity'/'either' はどれも通す", () => {
    expect(() => assertValidDecayClock("wall")).not.toThrow();
    expect(() => assertValidDecayClock("activity")).not.toThrow();
    expect(() => assertValidDecayClock("either")).not.toThrow();
  });

  it("それ以外の文字列は DECAY_CLOCK_INVALID_MESSAGE を含む Error で失敗する", () => {
    expect(() => assertValidDecayClock("nonsense")).toThrow(DECAY_CLOCK_INVALID_MESSAGE);
    expect(() => assertValidDecayClock("")).toThrow(DECAY_CLOCK_INVALID_MESSAGE);
  });
});

describe("isHalfLifeRecallsInRange（ADR 0125 と同じ値域、halfLifeHours の負債参照）", () => {
  it("正の有限値だけを通す", () => {
    expect(isHalfLifeRecallsInRange(1)).toBe(true);
    expect(isHalfLifeRecallsInRange(720)).toBe(true);
  });

  it("0・負・NaN・Infinity は拒む", () => {
    expect(isHalfLifeRecallsInRange(0)).toBe(false);
    expect(isHalfLifeRecallsInRange(-1)).toBe(false);
    expect(isHalfLifeRecallsInRange(Number.NaN)).toBe(false);
    expect(isHalfLifeRecallsInRange(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

/**
 * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md) の歯。
 * `readDecayClock`/`writeDecayClock` の歯（このファイル冒頭）と同じ形——
 * `readTaxonomyMode`/`writeTaxonomyMode` が `TenantSettingsStore` の2つの省略可能
 * メソッドへ読み書きする唯一の通り道であることを固定する。
 */
describe("readTaxonomyMode", () => {
  it("getTaxonomyMode を持たない adapter では DEFAULT_TAXONOMY_MODE（'open'）へ倒す", async () => {
    const mode = await readTaxonomyMode(minimalStore(), ctx);
    expect(mode).toBe(DEFAULT_TAXONOMY_MODE);
    expect(mode).toBe("open");
  });

  it("getTaxonomyMode が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getTaxonomyMode(_ctx: Ctx): Promise<TaxonomyMode> {
        return "strict";
      },
    };
    expect(await readTaxonomyMode(store, ctx)).toBe("strict");
  });

  it("getTaxonomyMode が在って投げた場合は、既定へ倒さず素通しで投げる（「未実装」と「失敗」を混ぜない）", async () => {
    await expect(readTaxonomyMode(throwingStore("db down"), ctx)).rejects.toThrow("db down");
  });
});

describe("writeTaxonomyMode", () => {
  it("setTaxonomyMode を持たない adapter では、既定へ倒さず TAXONOMY_MODE_UNSUPPORTED_MESSAGE を含む Error で明示的に失敗する", async () => {
    await expect(writeTaxonomyMode(minimalStore(), ctx, "strict")).rejects.toThrow(
      TAXONOMY_MODE_UNSUPPORTED_MESSAGE,
    );
  });

  it("setTaxonomyMode が在り成功すれば、そのまま委譲する", async () => {
    const written: TaxonomyMode[] = [];
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async setTaxonomyMode(_ctx: Ctx, mode: TaxonomyMode): Promise<void> {
        written.push(mode);
      },
    };
    await writeTaxonomyMode(store, ctx, "strict");
    expect(written).toEqual(["strict"]);
  });

  it("setTaxonomyMode が在って投げた場合は素通しで投げる", async () => {
    await expect(writeTaxonomyMode(throwingStore("db down"), ctx, "strict")).rejects.toThrow(
      "db down",
    );
  });
});

describe("assertValidTaxonomyMode", () => {
  it("'open'/'strict' はどちらも通す", () => {
    expect(() => assertValidTaxonomyMode("open")).not.toThrow();
    expect(() => assertValidTaxonomyMode("strict")).not.toThrow();
  });

  it("それ以外の文字列は TAXONOMY_MODE_INVALID_MESSAGE を含む Error で失敗する", () => {
    expect(() => assertValidTaxonomyMode("nonsense")).toThrow(TAXONOMY_MODE_INVALID_MESSAGE);
    expect(() => assertValidTaxonomyMode("")).toThrow(TAXONOMY_MODE_INVALID_MESSAGE);
  });

  // Issue #1775 の #717（変異19）: 2値に近い綴りも通さない（値は 'open'/'strict' の2値だけ。ADR 0318 決定）。
  it.each(["Strict", "OPEN", "closed", " open", "strict ", "enforced"])(
    "2値に近い綴り %j も TAXONOMY_MODE_INVALID_MESSAGE を含む Error で失敗する",
    (value) => {
      expect(() => assertValidTaxonomyMode(value)).toThrow(TAXONOMY_MODE_INVALID_MESSAGE);
    },
  );
});
