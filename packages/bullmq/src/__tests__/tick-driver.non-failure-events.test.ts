import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx, TickOptions } from "@mnemora/core";

// Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1491 の変異試験で、「成功した tick でも
// `onTickError` を呼ぶ」（`worker.on("completed", ...)` で通知する）変異がすり抜けた。担当はクローン（miku）の
// 判断で進めている作業であり、オーナーの判断ではない。
//
// `tick-driver.failed.test.ts` の「成功した tick は onTickError を呼ばない」は processor を呼ぶだけで、
// 実 Worker が成功のときに emit する `'completed'` を emit しない（`'failed'` が来ないことしか見ていない）。
// Redis の歯（`tick-driver.failed.redis.test.ts`）は Redis が無い環境では走らない。ここは Redis を要らない形で、
// 実 Worker が emit する失敗でない出来事（`completed`・`active`・`stalled` など）を一通り emit して、
// `onTickError` が0回であることを見る。陽性対照として `'failed'`・`'error'` では呼ばれる。

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
    on = vi.fn().mockReturnThis();
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

function build(onTickError: (err: unknown) => void) {
  createBullmqTickDriver({
    connection: {},
    queueName: "q",
    runtime: { tick: vi.fn().mockResolvedValue({ processed: 0 }) },
    ctx: CTX,
    tick: TICK,
    everyMs: 1000,
    onTickError,
  });
  return workers.at(-1)!;
}

describe("createBullmqTickDriver() — 失敗でない Worker の出来事では onTickError を呼ばない（Issue #1734 / PR #1491 のすり抜け）", () => {
  it("成功した job の 'completed'（job, result, prev）で onTickError を呼ばない", async () => {
    const onTickError = vi.fn();
    const worker = build(onTickError);
    const job = { id: "job-1", name: "mnemora-tick" };

    const result = await worker.processor(job);
    worker.emit("completed", job, result, "active");

    expect(onTickError).not.toHaveBeenCalled();
  });

  it.each([
    ["active", [{ id: "job-1" }, "waiting"]],
    ["progress", [{ id: "job-1" }, 50]],
    ["stalled", ["job-1", "active"]],
    ["drained", []],
    ["ready", []],
    ["paused", []],
    ["resumed", []],
    ["closing", ["closing"]],
    ["closed", []],
  ])("'%s' で onTickError を呼ばない", (event, args) => {
    const onTickError = vi.fn();
    const worker = build(onTickError);

    worker.emit(event, ...args);

    expect(onTickError).not.toHaveBeenCalled();
  });

  it("陽性対照: 'failed'・'error' では呼ぶ（探り棒が生きている）", () => {
    const onTickError = vi.fn();
    const worker = build(onTickError);
    const boom = new Error("boom");

    worker.emit("failed", { id: "job-1" }, boom, "active");
    worker.emit("error", boom);

    expect(onTickError).toHaveBeenCalledTimes(2);
  });
});
