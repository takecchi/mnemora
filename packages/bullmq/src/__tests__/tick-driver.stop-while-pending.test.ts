import { beforeEach, describe, expect, it, vi } from "vitest";

// `stop()` が `getWorkers()` を待っている間（まだ返っていない間）の `start()` と、起動の途中の登録の戻りを見る。

interface MockQueueInstance {
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  getWorkers: ReturnType<typeof vi.fn>;
}

interface MockWorkerInstance {
  run: ReturnType<typeof vi.fn>;
}

const queueInstances: MockQueueInstance[] = [];
const workerInstances: MockWorkerInstance[] = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    getWorkers = vi.fn().mockResolvedValue([]);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
    constructor(..._args: unknown[]) {
      queueInstances.push(this);
    }
  }
  class Worker {
    on = vi.fn().mockReturnThis();
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    emit = vi.fn();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createBullmqTickDriver() — stop() を呼んだ時点から、まだ返っていなくても再開しない", () => {
  it("起動の途中で stop() を呼び、stop() が返る前に登録が返っても、Worker を走らせない", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    const upsert = deferred<void>();
    const workers = deferred<unknown[]>();
    queue.upsertJobScheduler.mockReturnValueOnce(upsert.promise);
    queue.getWorkers.mockReturnValueOnce(workers.promise);

    const starting = driver.start();
    const stopping = driver.stop();
    upsert.resolve();
    await starting.catch(() => {});

    expect(worker.run).not.toHaveBeenCalled();

    workers.resolve([]);
    await stopping;
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("stop() がまだ返っていない間に呼んだ start() は Error で reject し、登録しない", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    const workers = deferred<unknown[]>();
    queue.getWorkers.mockReturnValueOnce(workers.promise);

    const stopping = driver.stop();
    const starting = driver.start();
    workers.resolve([]);
    await stopping;

    await expect(starting).rejects.toThrow(/stop\(\) 済みの driver で start\(\) は呼べない/);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(worker.run).not.toHaveBeenCalled();
  });
});
