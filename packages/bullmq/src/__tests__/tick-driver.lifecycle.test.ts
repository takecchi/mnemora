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

describe("createBullmqTickDriver() — start() を呼ぶまでジョブを処理しない（Issue #890）", () => {
  it("Worker は autorun: false で構築される", () => {
    makeDriver();
    const ctorArgs = workerCtorArgs.at(-1)!;
    const workerOpts = ctorArgs[2] as { autorun?: boolean };
    expect(workerOpts.autorun).toBe(false);
  });

  it("start() を呼ぶ前は worker.run() が呼ばれない", () => {
    makeDriver();
    const worker = workerInstances.at(-1)!;
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("start() を呼ぶと worker.run() が呼ばれる", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;

    await driver.start();

    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("worker.run() の reject は onTickError へ流れる（握りつぶさない）", async () => {
    const onTickError = vi.fn();
    const driver = makeDriver(onTickError);
    const worker = workerInstances.at(-1)!;
    const boom = new Error("run boom");
    worker.run.mockReturnValueOnce(Promise.reject(boom));

    await driver.start();
    // `.catch()` 経由で非同期に伝播するため、マイクロタスクを1回逃がす。
    await Promise.resolve();
    await Promise.resolve();

    expect(onTickError).toHaveBeenCalledWith(boom);
  });
});

describe("createBullmqTickDriver() — stop() の後は再開できない（Issue #891）", () => {
  it("stop() の後の start() は Error で reject する", async () => {
    const driver = makeDriver();
    await driver.start();
    await driver.stop();

    await expect(driver.start()).rejects.toThrow(/stop\(\)|再開|createBullmqTickDriver/);
  });

  it("stop() の後の start() では upsertJobScheduler が呼ばれない", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    await driver.start();
    await driver.stop();
    queue.upsertJobScheduler.mockClear();

    await expect(driver.start()).rejects.toThrow();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("start() を呼ばずに stop() を呼んでも壊れない（run() 前の close も安全）", async () => {
    const driver = makeDriver();
    const worker = workerInstances.at(-1)!;
    const queue = queueInstances.at(-1)!;

    await expect(driver.stop()).resolves.toBeUndefined();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("stop() の前の start() の重複呼び出しは今どおり冪等（2回目は何もしない）", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;

    await driver.start();
    await driver.start();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });
});

describe("createBullmqTickDriver() — start() が途中で失敗したら、次の start() でやり直せる（Issue #963）", () => {
  it("1回目の upsertJobScheduler が失敗しても、2回目の start() でスケジュールが登録され Worker が1回だけ走る", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));

    await expect(driver.start()).rejects.toThrow("redis down");
    await driver.start();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    await expect(queue.upsertJobScheduler.mock.results[1]!.value).resolves.toBeUndefined();
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("start() が失敗した時点では Worker を走らせたまま残さない", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));

    await expect(driver.start()).rejects.toThrow("redis down");

    expect(worker.run).not.toHaveBeenCalled();
  });

  it("同時に呼んだ start() は同じ起動を待つ（登録も Worker の起動も1回だけ）", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;

    await Promise.all([driver.start(), driver.start()]);

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("起動の途中で stop() が呼ばれたら、登録が返った後に Worker を走らせない", async () => {
    const driver = makeDriver();
    const queue = queueInstances.at(-1)!;
    const worker = workerInstances.at(-1)!;
    let resolveUpsert!: () => void;
    queue.upsertJobScheduler.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveUpsert = resolve;
      }),
    );

    const starting = driver.start();
    await driver.stop();
    resolveUpsert();
    await starting.catch(() => {});

    expect(worker.run).not.toHaveBeenCalled();
  });
});
