import { beforeEach, describe, expect, it, vi } from "vitest";

// Redis を要らない検査（`bullmq` の `Queue`/`Worker` を丸ごとモックに差し替える）。
// Issue #890 / #891 の2点を検査する:
//   (890) Worker は `autorun: false` で構築され、`start()` を呼ぶまでジョブを処理しない
//         （実 Worker では `run()` を呼ぶことがジョブ処理の開始そのもの）。
//   (891) `stop()` の後の `start()` は無言で成功したふりをせず、理由の分かる Error で reject する。
// 実際に Redis へ繋ぐ経路・BullMQ 自身の挙動は `concurrent-tick.redis.test.ts`
// （`test:redis`）側で検査しており、ここはその手前——driver の状態遷移だけを、
// 外側の副作用を起こさずに検査する。

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
    constructor(..._args: unknown[]) {
      queueInstances.push(this);
    }
  }
  class Worker {
    on = vi.fn();
    // 実 Worker の `run()` は Worker が閉じるまで resolve しない promise を返す
    // （bullmq 6.3.8 の `mainLoop` は `while ((!this.closing && !this.paused) || ...)`）。
    // 既定では、テストの中で明示的に解決/拒否させない限り pending のままにしておく
    // ——「呼ばれたかどうか」だけを検査するのに、実物の「返らない」性質を壊さないため。
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    // 実 EventEmitter と同じく、on() で登録したリスナーを実際に呼べるようにしておく
    // （run() の reject を `worker.emit("error", ...)` で流す実装を検査するため）。
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(..._args: unknown[]) {
      workerCtorArgs.push(_args);
      workerInstances.push(this);
      this.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        (this.listeners[event] ??= []).push(listener);
        return this;
      });
      this.emit = vi.fn().mockImplementation((event: string, ...args: unknown[]) => {
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
    // run() の reject は非同期に伝播する（`.catch()` 経由）ため、マイクロタスクを1回逃がす。
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
