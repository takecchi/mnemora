import { Queue } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import type { TickResult } from "@mnemora/core";
import { createBullmqTickDriver } from "../tick-driver.js";
import type { BullmqTickDriver } from "../tick-driver.js";

/** `tick-driver.failed.test.ts` の fake が実物の emit とずれていないことを、実 Redis で確かめる。 */
const REDIS_PORT = process.env.REDIS_PORT;
if (!REDIS_PORT) {
  throw new Error("tick-driver.failed.redis.test: missing env REDIS_PORT（test:redis 専用）");
}
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";

let driver: BullmqTickDriver | undefined;
afterEach(async () => {
  await driver?.stop();
  driver = undefined;
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("実 Redis: tick の失敗が onTickError に届く", () => {
  it("runtime.tick() が throw すると onTickError が error を受け取り、onTickResult は呼ばれない", async () => {
    const boom = new Error("tick boom");
    const errors: unknown[] = [];
    const results: TickResult[] = [];
    driver = createBullmqTickDriver({
      connection: { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null },
      queueName: `mnemora-tick-failed-${Date.now()}`,
      runtime: {
        tick: () => Promise.reject(boom),
      },
      ctx: { tenantId: "t1" },
      tick: { leaseMs: 1000 },
      everyMs: 100,
      onTickError: (e) => errors.push(e),
      onTickResult: (r) => results.push(r),
    });
    await driver.start();

    await waitFor(() => errors.length >= 1, 15_000);

    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("tick boom");
    expect(results).toEqual([]);
  });

  it("ADR 0548: 失敗したジョブは Redis に残る（removeOnFail を指定しない。onTickError に届いた件数以上ある）", async () => {
    const queueName = `mnemora-tick-failed-keep-${Date.now()}`;
    const queue = new Queue(queueName, {
      connection: { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null },
    });
    try {
      const errors: unknown[] = [];
      driver = createBullmqTickDriver({
        connection: { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null },
        queueName,
        runtime: {
          tick: () => Promise.reject(new Error("tick boom")),
        },
        ctx: { tenantId: "t1" },
        tick: { leaseMs: 1000 },
        everyMs: 50,
        onTickError: (e) => errors.push(e),
      });
      await driver.start();
      await waitFor(() => errors.length >= 3, 15_000);
      await driver.stop();
      driver = undefined;
      const counts = await queue.getJobCounts("failed");
      expect(counts.failed).toBeGreaterThanOrEqual(errors.length);
      expect(counts.failed).toBeGreaterThanOrEqual(3);
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });
});
