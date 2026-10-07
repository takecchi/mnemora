import { Queue } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { createBullmqTickDriver } from "../tick-driver.js";
import type { BullmqTickDriver } from "../tick-driver.js";

/** redis-server 7.4.7・bullmq 6.3.8 で測った振る舞いを縛る。モックでは scheduler の共有や保持件数が実物どおりか分からない。 */
const REDIS_PORT = process.env.REDIS_PORT;
if (!REDIS_PORT) {
  throw new Error(
    "tick-driver.shared-scheduler.redis.test: missing env REDIS_PORT（test:redis 専用）",
  );
}
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const connection = { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null };

const drivers: BullmqTickDriver[] = [];
const queues: Queue[] = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.stop().catch(() => undefined);
  for (const q of queues.splice(0)) {
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await sleep(25);
  }
}

function make(
  queueName: string,
  everyMs: number,
  onTick: () => void,
  jobName?: string,
  extra: { completedJobsToKeep?: number } = {},
) {
  const d = createBullmqTickDriver({
    connection,
    queueName,
    runtime: {
      tick: async () => {
        onTick();
        return { claimed: 0 } as never;
      },
    },
    ctx: { tenantId: "t1" },
    tick: { leaseMs: 1000 },
    everyMs,
    ...(jobName === undefined ? {} : { jobName }),
    ...extra,
  });
  drivers.push(d);
  return d;
}

function queueFor(name: string): Queue {
  const q = new Queue(name, { connection });
  queues.push(q);
  return q;
}

describe("実 Redis: 共有の scheduler（ADR 0449）", () => {
  it("同じ queueName・jobName の scheduler は1つで、後から start() した driver の everyMs になる", async () => {
    const name = `mnemora-tick-shared-every-${Date.now()}`;
    const q = queueFor(name);
    const a = make(name, 60_000, () => undefined);
    await a.start();
    expect((await q.getJobSchedulers()).map((s) => s.every)).toEqual([60_000]);
    await a.start();
    expect((await q.getJobSchedulers()).map((s) => s.every)).toEqual([60_000]);
    const b = make(name, 120_000, () => undefined);
    await b.start();
    expect((await q.getJobSchedulers()).map((s) => s.every)).toEqual([120_000]);
  });

  it("1台の stop() は、他の Worker が居れば共有の scheduler を消さず、動いたままの別の driver の tick は続く（ADR 0655）", async () => {
    const name = `mnemora-tick-shared-stop-${Date.now()}`;
    const q = queueFor(name);
    let ticksA = 0;
    const a = make(name, 100, () => (ticksA += 1));
    const b = make(name, 100, () => undefined);
    await a.start();
    await b.start();
    await waitFor(() => ticksA >= 1, 10_000);

    await b.stop();
    expect((await q.getJobSchedulers()).length).toBe(1);
    const before = ticksA;
    await waitFor(() => ticksA >= before + 3, 10_000);
  });

  it("ADR 0548: 既定（直近 1000 件）の範囲では、完了したジョブは Redis に残る（以前の「残り続ける」と同じ見え方）", async () => {
    const name = `mnemora-tick-shared-keep-${Date.now()}`;
    const q = queueFor(name);
    let ticks = 0;
    const a = make(name, 50, () => (ticks += 1));
    await a.start();
    await waitFor(() => ticks >= 8, 15_000);
    await a.stop();
    const counts = await q.getJobCounts("completed");
    // 1000 件には遠いので、走った tick のぶん（最後の1回は完了の記録が間に合わないことがある）は残っている。
    expect(counts.completed).toBeGreaterThanOrEqual(ticks - 1);
    expect(counts.completed).toBeGreaterThanOrEqual(7);
  });

  it("ADR 0548: completedJobsToKeep を渡すと、完了したジョブはその件数で頭打ちになる（removeOnComplete: { count } が job に効く）", async () => {
    const name = `mnemora-tick-shared-cap-${Date.now()}`;
    const q = queueFor(name);
    let ticks = 0;
    const a = make(name, 50, () => (ticks += 1), undefined, { completedJobsToKeep: 3 });
    await a.start();
    await waitFor(() => ticks >= 12, 15_000);
    await a.stop();
    const counts = await q.getJobCounts("completed");
    expect(ticks).toBeGreaterThan(3);
    expect(counts.completed).toBeLessThanOrEqual(3);
    expect(counts.completed).toBeGreaterThanOrEqual(1);
  });

  it("ADR 0548: 頭打ちの件数は completedJobsToKeep ちょうどで、それより少なく消さない", async () => {
    const name = `mnemora-tick-shared-cap-exact-${Date.now()}`;
    const q = queueFor(name);
    let ticks = 0;
    const a = make(name, 50, () => (ticks += 1), undefined, { completedJobsToKeep: 3 });
    await a.start();
    // 3 件より十分多く完了させてから止める（最後の1回が完了を記録できなくても、11 件以上は完了している）。
    await waitFor(() => ticks >= 12, 15_000);
    await a.stop();
    const counts = await q.getJobCounts("completed");
    expect(counts.completed).toBe(3);
  });
});
