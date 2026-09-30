import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx, TickOptions } from "@mnemora/core";

// Redis を要らない検査。driver が作る `Queue`（繰り返しジョブの登録に使う）が `'error'` を emit したとき
// （Redis 接続の失敗など）、`onTickError` に届くことを縛る。以前は `Queue` に listener が無く、bullmq
// （6.3.8 の `QueueBase.emit`）が `console.error` へ固定で出すだけだった。
// fake は `QueueBase.emit` の形（listener が無い `'error'` は `console.error` へ落ちる）を写す。

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private listeners: Record<string, Listener[]> = {};
  on(event: string, listener: Listener): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  listenerCount(event: string): number {
    return (this.listeners[event] ?? []).length;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const ls = this.listeners[event] ?? [];
    if (ls.length === 0) {
      if (event === "error") console.error(args[0]); // bullmq の既定の落ち先
      return false;
    }
    for (const l of ls) l(...args);
    return true;
  }
}

const queues: FakeEmitter[] = [];
const workers: FakeEmitter[] = [];

vi.mock("bullmq", () => {
  class Queue extends FakeEmitter {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      super();
      queues.push(this);
    }
  }
  class Worker extends FakeEmitter {
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      super();
      workers.push(this);
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  queues.length = 0;
  workers.length = 0;
  vi.restoreAllMocks();
});

const CTX: Ctx = { tenantId: "t1" };
const TICK: TickOptions = { leaseMs: 1000 };

function create(onTickError?: (e: unknown) => void) {
  return createBullmqTickDriver({
    connection: {},
    queueName: "q",
    runtime: { tick: vi.fn() },
    ctx: CTX,
    tick: TICK,
    everyMs: 1000,
    ...(onTickError ? { onTickError } : {}),
  });
}

describe("createBullmqTickDriver() — Queue 側の error は onTickError に届く", () => {
  it("Queue が 'error' を emit すると、onTickError に error が1回だけ渡る", () => {
    const onTickError = vi.fn();
    create(onTickError);
    const infra = new Error("queue redis down");

    queues.at(-1)!.emit("error", infra);

    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError).toHaveBeenCalledWith(infra);
  });

  it("Queue の error と Worker の error は別々の接続の事象で、それぞれ1回ずつ届く", () => {
    const onTickError = vi.fn();
    create(onTickError);
    const q = new Error("queue side");
    const w = new Error("worker side");

    queues.at(-1)!.emit("error", q);
    workers.at(-1)!.emit("error", w);

    expect(onTickError.mock.calls).toEqual([[q], [w]]);
  });

  it("onTickError が無いとき、Queue に listener を付けない（bullmq の console.error を黙らせない）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    create();
    const infra = new Error("queue redis down");

    expect(queues.at(-1)!.listenerCount("error")).toBe(0);
    queues.at(-1)!.emit("error", infra);

    expect(spy).toHaveBeenCalledWith(infra);
  });
});
