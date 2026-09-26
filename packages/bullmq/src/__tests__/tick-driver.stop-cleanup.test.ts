import { beforeEach, describe, expect, it, vi } from "vitest";

// Redis を要らない検査（`bullmq` の `Queue`/`Worker` を丸ごとモックに差し替える）。
// `createBullmqTickDriver` 自体が実際に Redis へ繋ぐ経路は `concurrent-tick.redis.test.ts`
// （`test:redis`）側で検査しており、ここはその手前——`stop()` の資源の後始末の**手順**
// （どの順で何を呼ぶか、片方が失敗したときにもう片方へ進むか）だけを、外側の副作用を
// 起こさずに検査する。

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

    // 🔴 ここが赤くなる観測点: 現状の実装は
    //   try { await queue.removeJobScheduler(...) }
    //   finally { await worker.close(); await queue.close(); }
    // という並びなので、`worker.close()` が reject すると `queue.close()` の行に
    // 到達せず、Queue 側の Redis 接続が開いたまま残る。
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
