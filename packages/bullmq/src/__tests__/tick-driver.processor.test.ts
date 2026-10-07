import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx, TickOptions, TickResult } from "@mnemora/core";

type Processor = (job: unknown) => Promise<unknown>;
const processors: Processor[] = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
  }
  class Worker {
    on = vi.fn();
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    constructor(_name: string, processor: Processor) {
      processors.push(processor);
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  processors.length = 0;
});

describe("createBullmqTickDriver: Worker の処理関数は runtime.tick(ctx, tick) を1回だけ、渡された値のまま呼ぶ", () => {
  it("引数は設定の ctx・tick と同一の値、呼び出しは1回、戻り値を返し、onTickResult にも同じ値を渡す", async () => {
    const ctx: Ctx = { tenantId: "tenant-processor" };
    const tick: TickOptions = { leaseMs: 12_345, kinds: ["embed"] };
    const result: TickResult = { processed: 3, failed: 1, unsupported: [], leaseConflicts: [] };
    const runtimeTick = vi.fn().mockResolvedValue(result);
    const onTickResult = vi.fn();
    createBullmqTickDriver({
      connection: { host: "127.0.0.1", port: 1 },
      queueName: "q",
      runtime: { tick: runtimeTick },
      ctx,
      tick,
      everyMs: 100,
      onTickResult,
    } as never);
    expect(processors).toHaveLength(1);

    const returned = await processors[0]!({ id: "job-1" });

    expect(runtimeTick).toHaveBeenCalledTimes(1);
    expect(runtimeTick.mock.calls[0]![0]).toBe(ctx);
    expect(runtimeTick.mock.calls[0]![1]).toBe(tick);
    expect(returned).toBe(result);
    expect(onTickResult).toHaveBeenCalledTimes(1);
    expect(onTickResult).toHaveBeenCalledWith(result);
  });
});
