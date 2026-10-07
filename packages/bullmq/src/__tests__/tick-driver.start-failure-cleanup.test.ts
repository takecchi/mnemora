// 失敗した起動の後始末で Worker・Queue を閉じない。一度 close() した bullmq の Worker・Queue は再利用できず、次の start() でやり直せなくなる。

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockQueueInstance {
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  removeJobScheduler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockWorkerInstance {
  on: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
}

const queueInstances: MockQueueInstance[] = [];
const workerInstances: MockWorkerInstance[] = [];
const workerCtorArgs: unknown[][] = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
    constructor(..._args: unknown[]) {
      queueInstances.push(this);
    }
  }
  class Worker {
    on = vi.fn();
    // `run()` は既定で pending のままにする。実 Worker の `run()` は閉じるまで resolve しないので、「呼ばれたか」だけ見るのに実物の性質を壊さない。
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    emit = vi.fn();
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(..._args: unknown[]) {
      workerCtorArgs.push(_args);
      workerInstances.push(this);
      this.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        (this.listeners[event] ??= []).push(listener);
        return this;
      });
      this.emit.mockImplementation((event: string, ...args: unknown[]) => {
        for (const listener of this.listeners[event] ?? []) {
          listener(...args);
        }
        return true;
      });
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  queueInstances.length = 0;
  workerInstances.length = 0;
  workerCtorArgs.length = 0;
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

describe("createBullmqTickDriver() — 失敗した start() の後始末（#967）", () => {
  it("失敗した start() は Worker も Queue も閉じない（次の start() でやり直せるように）", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));

    await expect(driver.start()).rejects.toThrow("redis down");
    // 失敗の後始末は reject を観測した後の microtask で走りうるので1周待つ。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.close).not.toHaveBeenCalled();
    expect(queue.close).not.toHaveBeenCalled();

    await driver.start();
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(worker.close).not.toHaveBeenCalled();
    expect(queue.close).not.toHaveBeenCalled();
  });

  it("失敗が続いても、成功する start() が来たら登録して Worker を1回だけ走らせる", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    queue.upsertJobScheduler
      .mockRejectedValueOnce(new Error("redis down 1"))
      .mockRejectedValueOnce(new Error("redis down 2"));

    await expect(driver.start()).rejects.toThrow("redis down 1");
    await expect(driver.start()).rejects.toThrow("redis down 2");
    expect(worker.run).not.toHaveBeenCalled();
    await driver.start();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(3);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("失敗した start() は、登録が投げた例外そのものを reject する（包まない）", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const failure = new Error("redis down");
    queue.upsertJobScheduler.mockRejectedValueOnce(failure);

    await expect(driver.start()).rejects.toBe(failure);
  });
});
