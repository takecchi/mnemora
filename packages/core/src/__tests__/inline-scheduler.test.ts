import { describe, expect, it, vi } from "vitest";
import { InlineScheduler } from "../inline-scheduler.js";
import type { OutboxJob } from "../interfaces/scheduler.js";

const ctx = { tenantId: "tenant-1" };
const job: OutboxJob = { id: "job-1", tenantId: "tenant-1", kind: "extract", payload: {} };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMacrotask(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("InlineScheduler", () => {
  it("handler を ctx・job で1回呼び、成功時は解決する", async () => {
    const handler = vi.fn(async () => {});
    const scheduler = new InlineScheduler(handler);

    await scheduler.enqueue(ctx, job);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx, job);
  });

  it("handler が終わるまで enqueue は解決しない", async () => {
    const gate = deferred();
    const scheduler = new InlineScheduler(() => gate.promise);
    let settled = false;

    const pending = scheduler.enqueue(ctx, job).then(() => {
      settled = true;
    });
    await flushMacrotask();
    expect(settled).toBe(false);

    gate.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it("job の欄（availableAt を含む）を解釈せず、そのまま handler に渡す", async () => {
    const handler = vi.fn(async () => {});
    const scheduler = new InlineScheduler(handler);
    const full: OutboxJob = {
      ...job,
      payload: { observationId: "obs-1", nested: { n: 1 } },
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    await scheduler.enqueue(ctx, full);

    expect(handler).toHaveBeenCalledWith(ctx, full);
  });

  it("availableAt が未来でも待たず、その場で実行する", async () => {
    const handler = vi.fn(async () => {});
    const scheduler = new InlineScheduler(handler);
    const later: OutboxJob = { ...job, availableAt: new Date(Date.now() + 60 * 60 * 1000) };

    const outcome = await Promise.race([
      scheduler.enqueue(ctx, later).then(() => "done" as const),
      new Promise<"waited">((r) => setTimeout(() => r("waited"), 1000)),
    ]);

    expect(outcome).toBe("done");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("キューを持たない: 先の handler が終わっていなくても、次の enqueue の handler が呼ばれる", async () => {
    const gate = deferred();
    const handler = vi.fn(() => gate.promise);
    const scheduler = new InlineScheduler(handler);

    const first = scheduler.enqueue(ctx, job);
    const second = scheduler.enqueue(ctx, { ...job, id: "job-2" });
    await flushMacrotask();

    expect(handler).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("handler が失敗したら enqueue も同じ例外で失敗し、やり直さない（キューに逃さず、失敗を隠さない）", async () => {
    const boom = new Error("boom");
    const handler = vi.fn(async () => {
      throw boom;
    });
    const scheduler = new InlineScheduler(handler);

    await expect(scheduler.enqueue(ctx, job)).rejects.toBe(boom);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
