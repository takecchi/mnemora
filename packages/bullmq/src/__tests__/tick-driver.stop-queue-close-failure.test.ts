import { beforeEach, describe, expect, it, vi } from "vitest";

// Redis を要らない検査（`bullmq` の `Queue`/`Worker` をモックに差し替える）。
// `tick-driver.stop-cleanup.test.ts` は `worker.close()` と `removeJobScheduler()` の失敗を見ている。
// ここは最後に閉じる `queue.close()` の失敗が、`stop()` の呼び出し側へ届くことを見る
// （後始末の失敗を黙って捨てると、接続が残ったことが誰にも分からない）。

interface MockQueueInstance {
  removeJobScheduler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockWorkerInstance {
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

describe("createBullmqTickDriver().stop(): queue.close() の失敗", () => {
  it("queue.close() だけが失敗したときも、stop() はその失敗で reject する（worker.close() は済んでいる）", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;
    const queue = queueInstances.at(-1)!;
    queue.close.mockRejectedValueOnce(new Error("queue close boom"));

    await expect(driver.stop()).rejects.toThrow("queue close boom");

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("worker.close() と queue.close() の両方が失敗しても、stop() は reject する", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;
    const queue = queueInstances.at(-1)!;
    worker.close.mockRejectedValueOnce(new Error("worker close boom"));
    queue.close.mockRejectedValueOnce(new Error("queue close boom"));

    await expect(driver.stop()).rejects.toThrow();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});
