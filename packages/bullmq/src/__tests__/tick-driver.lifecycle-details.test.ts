import { beforeEach, describe, expect, it, vi } from "vitest";

const workerInstances: Array<{ run: ReturnType<typeof vi.fn> }> = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
  }
  class Worker {
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    on = vi.fn().mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      (this.listeners[event] ??= []).push(listener);
      return this;
    });
    emit = vi.fn().mockImplementation((event: string, ...args: unknown[]) => {
      for (const listener of this.listeners[event] ?? []) {
        listener(...args);
      }
      return true;
    });
    constructor() {
      workerInstances.push(this);
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  workerInstances.length = 0;
});

function makeDriver(onTickError?: (error: unknown) => void) {
  return createBullmqTickDriver({
    connection: {},
    queueName: "mnemora-tick-test",
    runtime: { tick: vi.fn() },
    ctx: { tenantId: "t1" },
    tick: { leaseMs: 1000 },
    everyMs: 1000,
    onTickError,
  });
}

describe("createBullmqTickDriver() のライフサイクルの細部", () => {
  it("worker.run() の reject は、onTickError へ1回だけ届く", async () => {
    const onTickError = vi.fn();
    const driver = makeDriver(onTickError);
    const boom = new Error("run boom");
    workerInstances.at(-1)!.run.mockReturnValueOnce(Promise.reject(boom));

    await driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError).toHaveBeenCalledWith(boom);
  });

  it("stop() の後の start() の Error は、使い捨てであることと、createBullmqTickDriver を呼び直すことを伝える", async () => {
    const driver = makeDriver();
    await driver.start();
    await driver.stop();

    const error = await driver.start().then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/使い捨て/);
    expect(error!.message).toMatch(/createBullmqTickDriver\(\.\.\.\) を呼び直す/);
  });
});
