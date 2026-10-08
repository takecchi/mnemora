import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx, TickOptions, TickResult } from "@mnemora/core";

// この fake の emit は bullmq の `QueueBase.emit` を写す: listener が throw したら `'error'` を emit し直し、
// それも throw したら（listener の無い `'error'` を含む）`console.error` に出して黙らない。

type Listener = (...args: unknown[]) => void;
type Processor = (job: unknown) => Promise<unknown>;

interface FakeWorker {
  processor: Processor;
  emit: (event: string, ...args: unknown[]) => boolean;
}

const workers: FakeWorker[] = [];

vi.mock("bullmq", async () => {
  const { EventEmitter } = await import("node:events");
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
  }
  class Worker extends EventEmitter {
    readonly processor: Processor;
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    constructor(_name: string, processor: Processor) {
      super();
      this.processor = processor;
      workers.push(this);
    }
    override emit(event: string, ...args: unknown[]): boolean {
      try {
        return super.emit(event, ...(args as Listener[]));
      } catch (err) {
        try {
          return super.emit("error", err);
        } catch (err2) {
          console.error(err2);
          return false;
        }
      }
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  workers.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CTX: Ctx = { tenantId: "t1" };
const TICK: TickOptions = { leaseMs: 1000 };
const RESULT: TickResult = { processed: 1, failed: 0, unsupported: [], leaseConflicts: [] };

function build(opts: {
  tick: () => Promise<TickResult>;
  onTickResult?: (result: TickResult) => void;
  onTickError?: (error: unknown) => void;
}): FakeWorker {
  createBullmqTickDriver({
    connection: {},
    queueName: "mnemora-tick-test",
    runtime: { tick: opts.tick },
    ctx: CTX,
    tick: TICK,
    everyMs: 1000,
    onTickResult: opts.onTickResult,
    onTickError: opts.onTickError,
  });
  return workers.at(-1)!;
}

describe("createBullmqTickDriver() — tick と onTickResult の失敗は、ジョブの失敗として onTickError に届く", () => {
  it("runtime.tick() が throw すると、処理関数はその error で reject し（ジョブは失敗として残る）、onTickResult は呼ばない", async () => {
    const boom = new Error("tick failed");
    const onTickResult = vi.fn();
    const worker = build({ tick: () => Promise.reject(boom), onTickResult });

    await expect(worker.processor({ id: "job-1" })).rejects.toBe(boom);
    expect(onTickResult).not.toHaveBeenCalled();
  });

  it("onTickResult が throw すると、処理関数はその error で reject し、'failed' 経由で onTickError に同じ error が届く", async () => {
    const boom = new Error("onTickResult failed");
    const onTickError = vi.fn();
    const worker = build({
      tick: () => Promise.resolve(RESULT),
      onTickResult: () => {
        throw boom;
      },
      onTickError,
    });

    const job = { id: "job-1" };
    const outcome = await worker.processor(job).then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    expect(outcome).toEqual({ rejected: true, error: boom });

    worker.emit("failed", job, boom, "active");
    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError).toHaveBeenCalledWith(boom);
  });

  it("onTickError を渡さないとき、Worker の 'error' は黙る（throw せず、console.error にも出さない）", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = build({ tick: () => Promise.resolve(RESULT) });

    expect(() => worker.emit("error", new Error("connection lost"))).not.toThrow();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
