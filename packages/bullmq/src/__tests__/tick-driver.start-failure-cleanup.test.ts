// #967 の確かめ直し（#1774）。`tick-driver.lifecycle.test.ts` の「start() が途中で失敗したら、次の start() でやり直せる（Issue #963）」が見ていない境界。
//
// 1. 失敗した起動の後始末で、Worker・Queue を閉じない。bullmq の Worker・Queue は一度 close() すると再利用できない
//    （Issue #891）ので、閉じてしまうと「次の start() でやり直せる」が実物では成り立たない。この PR の決定は
//    「失敗する手順の前に Worker を走らせないので、片付けるものが無い」である。
// 2. 失敗は何回続いても、成功する start() が来たら、その1回で登録して Worker を1回だけ走らせる。
// 3. 失敗した start() は、渡された例外をそのまま（包まずに）reject する。

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
    on = vi.fn().mockReturnThis();
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
    // 失敗の後始末は、reject を観測した後の microtask で走りうるので1周待つ
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
