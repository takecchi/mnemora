import { describe, expect, it } from "vitest";
import type { Runtime, TickResult } from "@mnemora/core";
import { drainEmbedTicks } from "../embed-drain.js";

/**
 * `drainEmbedTicks` の `expectedProcessed`/`waitForClockToAdvance` の歯（Issue #719）。
 *
 * **DB不要・鍵不要・運に頼らない**——`runtime.tick()` を差し替えた偽の `Runtime` で、
 * 「available_at と同じ ms に収まって claim が0件になる」という Issue #719 の競合を
 * *タイミングではなく呼び出し回数*で決定的に再現する。実際の Postgres の `now()` 精度・
 * 実時刻の揺れには一切依存しない（`embed-drain-clock-margin.test.ts` が
 * `clockPastRecentDbWrites` の数学的な土台を、`time-weighting-seed-drain-race.postgres.test.ts`
 * が実際の Postgres 上での claim 挙動を検査しているのに対し、ここは
 * `drainEmbedTicks` 自身の制御ロジック——「揃うまで待つ／待たずに例外にする」——だけを
 * 対象にする）。
 *
 * `runtime.tick` 以外は一切呼ばない（`drainEmbedTicks` の実装がそうなので、
 * 偽の `Runtime` も `tick` だけを実装すればよい）。
 */

function fakeRuntime(tick: Runtime["tick"]): Runtime {
  return { tick } as unknown as Runtime;
}

function tickResult(processed: number, failed = 0): TickResult {
  return { processed, failed, unsupported: [], leaseConflicts: [] };
}

const ctx = { tenantId: "drain-embed-ticks-expected-count" };

describe("examples/chat: drainEmbedTicks の expectedProcessed（Issue #719、DB不要・決定的）", () => {
  it("1回目の tick が0件でも（systemClock 想定）、待って drain し直し、揃ったら例外にならない", async () => {
    // 1・2回目の tick() は「available_at と同じ ms に収まって claim が0件になった」を
    // 模して processed:0 を返す。3回目でようやく claim できたことにする——
    // `waitForClockToAdvance`(既定 true)が実際に効くことを示す。
    let calls = 0;
    let remaining = 5;
    const runtime = fakeRuntime(async () => {
      calls += 1;
      if (calls <= 2) {
        return tickResult(0);
      }
      const take = Math.min(remaining, 50);
      remaining -= take;
      return tickResult(take);
    });

    const result = await drainEmbedTicks(runtime, ctx, {
      expectedProcessed: 5,
      maxWaitMs: 1000,
    });

    expect(result.totalProcessed).toBe(5);
    expect(result.totalFailed).toBe(0);
    // 3回目で5件処理・4回目で0件になって drainOnce のループが終わる、が最低限起きたはず。
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("embed 自体の失敗（failed）は『揃った』うちに数える——processed だけで比較しない", async () => {
    // 5件 claim され、そのうち2件が embed 自体に失敗した(例: 入力長超過)、という
    // 正常なシナリオ。claim 自体は1回目から揃っている——Issue #719 の競合は起きていない。
    // `result.processed !== 0` の1回目のあと、drainOnce のループは継続してもう1回
    // tick() を呼ぶ——2回目は processed:0 を返して「もう無い」で終わらせる。
    let calls = 0;
    const runtime = fakeRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        return tickResult(3, 2);
      }
      return tickResult(0);
    });

    const result = await drainEmbedTicks(runtime, ctx, {
      expectedProcessed: 5,
      maxWaitMs: 1000,
    });

    expect(result.totalProcessed).toBe(3);
    expect(result.totalFailed).toBe(2);
    expect(calls).toBe(2);
  });

  it("expectedProcessed が最後まで揃わなければ例外を投げる（待つ上限を超えたとき）", async () => {
    const runtime = fakeRuntime(async () => tickResult(0));

    await expect(
      drainEmbedTicks(runtime, ctx, {
        expectedProcessed: 5,
        maxWaitMs: 20,
      }),
    ).rejects.toThrow(/embed ジョブが 5 件処理されるはず/);
  });

  it("waitForClockToAdvance: false（MutableClock 想定）では、揃わなければ待たずに即座に例外を投げる", async () => {
    let calls = 0;
    const runtime = fakeRuntime(async () => {
      calls += 1;
      return tickResult(0);
    });

    const started = Date.now();
    await expect(
      drainEmbedTicks(runtime, ctx, {
        expectedProcessed: 5,
        waitForClockToAdvance: false,
        maxWaitMs: 5000, // 待たないことを検査したいので、わざと大きく取る
      }),
    ).rejects.toThrow(/embed ジョブが 5 件処理されるはず/);
    const elapsedMs = Date.now() - started;

    // drainOnce を1回呼んだだけで終わる(待ちのための sleep を一切挟まない)ことを
    // 呼び出し回数と経過時間の両方で確かめる。
    expect(calls).toBe(1);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("expectedProcessed を渡さなければ、従来どおり processed === 0 だけで終える", async () => {
    let calls = 0;
    const runtime = fakeRuntime(async () => {
      calls += 1;
      // 1回目は0件——expectedProcessed が無いので、これだけで「もう無い」と判定される
      // （待ち直しは起きない）。
      return tickResult(0);
    });

    const result = await drainEmbedTicks(runtime, ctx);

    expect(result.totalProcessed).toBe(0);
    expect(calls).toBe(1);
  });
});
