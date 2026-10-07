import { describe, expect, it } from "vitest";
import type { Runtime, TickResult } from "@mnemora/core";
import { drainEmbedTicks } from "../embed-drain.js";

function fakeRuntime(tick: Runtime["tick"]): Runtime {
  return { tick } as unknown as Runtime;
}

function tickResult(processed: number, failed = 0): TickResult {
  return { processed, failed, unsupported: [], leaseConflicts: [] };
}

const ctx = { tenantId: "drain-embed-ticks-expected-count" };

describe("examples/chat: drainEmbedTicks の expectedProcessed（Issue #719、DB不要・決定的）", () => {
  it("1回目の tick が0件でも（systemClock 想定）、待って drain し直し、揃ったら例外にならない", async () => {
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
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("embed 自体の失敗（failed）は『揃った』うちに数える——processed だけで比較しない", async () => {
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

    expect(calls).toBe(1);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("expectedProcessed を渡さなければ、従来どおり processed === 0 だけで終える", async () => {
    let calls = 0;
    const runtime = fakeRuntime(async () => {
      calls += 1;
      return tickResult(0);
    });

    const result = await drainEmbedTicks(runtime, ctx);

    expect(result.totalProcessed).toBe(0);
    expect(calls).toBe(1);
  });
});
