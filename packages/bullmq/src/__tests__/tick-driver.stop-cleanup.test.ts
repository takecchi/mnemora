import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockQueueInstance {
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  removeJobScheduler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockWorkerInstance {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const queueInstances: MockQueueInstance[] = [];
const workerInstances: MockWorkerInstance[] = [];

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
    close = vi.fn().mockResolvedValue(undefined);
    constructor(..._args: unknown[]) {
      workerInstances.push(this);
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  queueInstances.length = 0;
  workerInstances.length = 0;
});

function makeDriver() {
  return createBullmqTickDriver({
    connection: {},
    queueName: "mnemora-tick-test",
    runtime: { tick: vi.fn() },
    ctx: { tenantId: "t1" },
    tick: { leaseMs: 1000 },
    everyMs: 1000,
  });
}

describe("createBullmqTickDriver().stop() の資源の後始末", () => {
  it("worker.close() が失敗しても queue.close() は必ず試みられる（接続を残さない）", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;
    const queue = queueInstances.at(-1)!;
    worker.close.mockRejectedValueOnce(new Error("worker close boom"));

    await expect(driver.stop()).rejects.toThrow("worker close boom");

    // `worker.close()` が reject しても `queue.close()` に進むこと。try/finally で並べた実装だと `queue.close()` に届かず Redis 接続が残るので、ここで赤くなる。
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("removeJobScheduler() が失敗しても worker.close()/queue.close() は両方試みられる", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;
    const queue = queueInstances.at(-1)!;
    queue.removeJobScheduler.mockRejectedValueOnce(new Error("remove boom"));

    await expect(driver.stop()).rejects.toThrow("remove boom");

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("正常系では removeJobScheduler → worker.close → queue.close の順で呼ばれる", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;
    const queue = queueInstances.at(-1)!;
    const order: string[] = [];
    queue.removeJobScheduler.mockImplementationOnce(async () => {
      order.push("removeJobScheduler");
    });
    worker.close.mockImplementationOnce(async () => {
      order.push("worker.close");
    });
    queue.close.mockImplementationOnce(async () => {
      order.push("queue.close");
    });

    await driver.stop();

    expect(order).toEqual(["removeJobScheduler", "worker.close", "queue.close"]);
  });
});
