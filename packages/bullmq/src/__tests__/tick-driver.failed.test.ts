import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx, TickOptions } from "@mnemora/core";

// Redis を要らない検査。processor（`runtime.tick()` を呼ぶ関数）が throw したとき、
// BullMQ の Worker は **`'error'` ではなく `'failed'`（job, err, prev）を emit する**
// ——bullmq 6.3.8 の `worker.js` `handleFailed`（`this.emit('failed', job, err, 'active')`）と、
// 実 Redis（`tick-driver.failed.redis.test.ts`）での実測による。この fake はその emit を写し、
// driver が `'failed'` を拾って `onTickError` へ **error（job ではない）** を渡すことを縛る。

type Listener = (...args: unknown[]) => void;
type Processor = (job: unknown) => Promise<unknown>;

interface FakeWorker {
  processor: Processor;
  emit: (event: string, ...args: unknown[]) => boolean;
}

const workers: FakeWorker[] = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  }
  class Worker {
    readonly processor: Processor;
    private listeners: Record<string, Listener[]> = {};
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    constructor(_name: string, processor: Processor) {
      this.processor = processor;
      workers.push(this);
    }
    on(event: string, listener: Listener): this {
      (this.listeners[event] ??= []).push(listener);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      for (const l of this.listeners[event] ?? []) l(...args);
      return true;
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  workers.length = 0;
});

const CTX: Ctx = { tenantId: "t1" };
const TICK: TickOptions = { leaseMs: 1000 };

/** 実 Worker がしていること（processor を呼び、throw したら `'failed'` を emit する）を写す。 */
async function runJob(worker: FakeWorker, job: unknown): Promise<void> {
  try {
    await worker.processor(job);
  } catch (err) {
    worker.emit("failed", job, err, "active");
  }
}

describe("createBullmqTickDriver() — tick の失敗は onTickError に届く", () => {
  it("runtime.tick() が throw すると、'failed' 経由で onTickError に error（job ではない）が渡る", async () => {
    const boom = new Error("tick boom");
    const onTickError = vi.fn();
    const onTickResult = vi.fn();
    createBullmqTickDriver({
      connection: {},
      queueName: "q",
      runtime: { tick: vi.fn().mockRejectedValue(boom) },
      ctx: CTX,
      tick: TICK,
      everyMs: 1000,
      onTickError,
      onTickResult,
    });

    await runJob(workers.at(-1)!, { id: "job-1", name: "mnemora-tick" });

    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError).toHaveBeenCalledWith(boom);
    expect(onTickResult).not.toHaveBeenCalled();
  });

  it("'error' は従来どおり1回だけ onTickError に届く（'failed' と二重に通知しない）", () => {
    const onTickError = vi.fn();
    createBullmqTickDriver({
      connection: {},
      queueName: "q",
      runtime: { tick: vi.fn() },
      ctx: CTX,
      tick: TICK,
      everyMs: 1000,
      onTickError,
    });
    const infra = new Error("redis down");

    workers.at(-1)!.emit("error", infra);

    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError).toHaveBeenCalledWith(infra);
  });

  it("成功した tick は onTickError を呼ばない", async () => {
    const onTickError = vi.fn();
    const onTickResult = vi.fn();
    const result = { processed: 0 };
    createBullmqTickDriver({
      connection: {},
      queueName: "q",
      runtime: { tick: vi.fn().mockResolvedValue(result) },
      ctx: CTX,
      tick: TICK,
      everyMs: 1000,
      onTickError,
      onTickResult,
    });

    await runJob(workers.at(-1)!, { id: "job-1" });

    expect(onTickError).not.toHaveBeenCalled();
    expect(onTickResult).toHaveBeenCalledWith(result);
  });
});
