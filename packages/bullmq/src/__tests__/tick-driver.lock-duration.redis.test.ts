import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { createBullmqTickDriver } from "../tick-driver.js";
import type { BullmqTickDriver } from "../tick-driver.js";

/**
 * 実 Redis（`REDIS_PORT`）で、`lockDuration`（ADR 0548）が Worker の lock の期限として Redis に届くことを縛る。
 *
 * tick の途中で止めておき、実行中の job の lock キー（bullmq 6.3.8 では `queue.toKey(jobId) + ":lock"`）の
 * `PTTL` を読む。BullMQ は lock を `lockDuration` ミリ秒で取り、既定では `lockDuration / 2` ごとに延ばすので、
 * 読んだ値は `lockDuration / 2` より大きく `lockDuration` 以下に入る。
 *
 * - 渡したとき（60000）: 既定の 30000 より大きい。
 * - 渡さないとき: BullMQ の既定（30000）の範囲。driver が勝手に値を載せていない。
 *
 * ⚠ stalled が減ること（ADR 0449 の 45 秒の測定）はここでは見ない。見るのは期限が Redis に届くことだけ。
 */
const REDIS_PORT = process.env.REDIS_PORT;
if (!REDIS_PORT) {
  throw new Error(
    "tick-driver.lock-duration.redis.test: missing env REDIS_PORT（test:redis 専用）",
  );
}
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const connection = { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null };

const drivers: BullmqTickDriver[] = [];
const queues: Queue[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const d of drivers.splice(0)) await d.stop().catch(() => undefined);
  for (const q of queues.splice(0)) {
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** tick の途中で止めた状態で、実行中の job の lock キーの PTTL（ミリ秒）を返す。 */
async function lockPttlDuringTick(extra: { lockDuration?: number }): Promise<number> {
  const queueName = `mnemora-tick-lock-duration-${Date.now()}`;
  const queue = new Queue(queueName, { connection });
  queues.push(queue);
  let entered = false;
  const blocked = new Promise<void>((resolve) => releases.push(resolve));
  const d = createBullmqTickDriver({
    connection,
    queueName,
    runtime: {
      tick: async () => {
        entered = true;
        await blocked;
        return { claimed: 0 } as never;
      },
    },
    ctx: { tenantId: "t1" },
    tick: { leaseMs: 1000 },
    everyMs: 200,
    ...extra,
  });
  drivers.push(d);
  await d.start();
  await waitFor(() => entered, 15_000);
  const [job] = await queue.getActive();
  expect(job?.id).toBeDefined();
  // bullmq の Queue は Redis の接続を公開していないので、同じ Redis へ別の接続を張って読む。
  const redis = new Redis({ host: REDIS_HOST, port: Number(REDIS_PORT) });
  try {
    return await redis.pttl(`${queue.toKey(job!.id!)}:lock`);
  } finally {
    redis.disconnect();
  }
}

describe("実 Redis: lockDuration が lock の期限として届く（ADR 0548）", () => {
  it("lockDuration: 60000 を渡すと、実行中の job の lock は既定の 30000 より長い期限で取られる", async () => {
    const pttl = await lockPttlDuringTick({ lockDuration: 60_000 });
    expect(pttl).toBeGreaterThan(30_000);
    expect(pttl).toBeLessThanOrEqual(60_000);
  });

  it("lockDuration を渡さないと、BullMQ の既定（30000）の範囲のまま", async () => {
    const pttl = await lockPttlDuringTick({});
    expect(pttl).toBeGreaterThan(15_000);
    expect(pttl).toBeLessThanOrEqual(30_000);
  });
});
