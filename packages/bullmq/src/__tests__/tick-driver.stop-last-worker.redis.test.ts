import { Queue, Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBullmqTickDriver } from "../tick-driver.js";
import type { BullmqTickDriver } from "../tick-driver.js";

/**
 * 実 Redis（`REDIS_PORT`）での歯: 「最後の Worker だけが共有 scheduler を消す」（ADR 0655、ADR 0449 の材料3の一部を直す）。
 *
 * ## 捕まえるもの
 * - 同じ `queueName`・`jobName` の driver が2台以上居るとき、1台の `stop()` が scheduler を消さず、残った driver の tick が
 *   発火し続けること（本体）。
 * - 陽性対照: driver が1台だけなら、`stop()` は今までどおり scheduler を消すこと（「自分」を数えて消さない側に倒していない）。
 * - 全員が順に `stop()` したら、最後の1台が scheduler を消すこと（残骸にならない）。
 * - 名前なしの Worker（ADR 0655 より前の版の driver）も「他」と数えること。本物の CLIENT LIST での接続名が
 *   `bull:<base64(queue)>`（`:w:` が無い）であることも、ここで確かめる（単体の歯のモックはこの形を前提にしている）。
 * - `queue.getWorkers()`（CLIENT LIST に頼る）が使えない環境（throw する／bullmq が CLIENT 非対応時に返す偽の1件）では、
 *   2台居ても今までどおり消す側に倒れること。注入は `Queue.prototype.getWorkers` の spy で行う（公開 API に注入口は無い）。
 *
 * ## 捕まえないもの（既知の残り。ADR 0655「引き受けた負債」）
 * - 2台が同時に `stop()` すると、互いに相手を見てどちらも消さず、scheduler が1件残る。この競合は縛らない（再現も保証もしない）。
 * - Redis を永続化なしで再起動すると scheduler が消える件（ADR 0449 の (b)）。
 * - CLIENT LIST を禁じた本物の Redis（ACL など）。ここでは `getWorkers` の失敗の注入でしか見ていない。
 * - 長時間（数分以上）の発火。観測は数秒である。
 */
const REDIS_PORT = process.env.REDIS_PORT;
if (!REDIS_PORT) {
  throw new Error(
    "tick-driver.stop-last-worker.redis.test: missing env REDIS_PORT（test:redis 専用）",
  );
}
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const connection = { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null };

const drivers: BullmqTickDriver[] = [];
const queues: Queue[] = [];
const rawWorkers: Worker[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of drivers.splice(0)) await d.stop().catch(() => undefined);
  for (const w of rawWorkers.splice(0)) await w.close().catch(() => undefined);
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

function make(queueName: string, onTick: () => void): BullmqTickDriver {
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
    everyMs: 100,
  });
  drivers.push(d);
  return d;
}

function queueFor(name: string): Queue {
  const q = new Queue(name, { connection });
  queues.push(q);
  return q;
}

describe("実 Redis: 最後の Worker だけが共有 scheduler を消す（ADR 0655）", () => {
  it("2台のうち1台が stop() しても、scheduler は残り、残った driver の tick は発火し続ける", async () => {
    const name = `mnemora-tick-last-body-${Date.now()}`;
    const q = queueFor(name);
    let ticksA = 0;
    const a = make(name, () => (ticksA += 1));
    const b = make(name, () => undefined);
    await a.start();
    await b.start();
    // 陽性対照: stop() の前は発火している。
    await waitFor(() => ticksA >= 1, 10_000);

    await b.stop();
    expect((await q.getJobSchedulers()).length).toBe(1);
    // stop() の後に、a の tick が増え続ける（進行中の1回を越えて、少なくとも3回）。
    const before = ticksA;
    await waitFor(() => ticksA >= before + 3, 10_000);
    expect((await q.getJobSchedulers()).length).toBe(1);
  });

  it("全員が順に stop() したら、最後の1台が scheduler を消す", async () => {
    const name = `mnemora-tick-last-all-${Date.now()}`;
    const q = queueFor(name);
    const a = make(name, () => undefined);
    const b = make(name, () => undefined);
    await a.start();
    await b.start();
    await b.stop();
    expect((await q.getJobSchedulers()).length).toBe(1);
    await a.stop();
    expect(await q.getJobSchedulers()).toEqual([]);
  });

  it("陽性対照: driver が1台だけなら、stop() は今までどおり scheduler を消す（自分を数えて消さないのではない）", async () => {
    const name = `mnemora-tick-last-single-${Date.now()}`;
    const q = queueFor(name);
    const a = make(name, () => undefined);
    await a.start();
    expect((await q.getJobSchedulers()).length).toBe(1);
    await a.stop();
    expect(await q.getJobSchedulers()).toEqual([]);
  });

  it("getWorkers() が throw する環境（CLIENT LIST 禁止など）では、2台居ても今までどおり scheduler を消す", async () => {
    const name = `mnemora-tick-last-throw-${Date.now()}`;
    const q = queueFor(name);
    const a = make(name, () => undefined);
    const b = make(name, () => undefined);
    await a.start();
    await b.start();
    vi.spyOn(Queue.prototype, "getWorkers").mockRejectedValue(
      new Error("NOPERM this user has no permissions to run the 'client' command"),
    );
    await b.stop();
    expect(await q.getJobSchedulers()).toEqual([]);
  });

  it("getWorkers() が偽の1件（bullmq が CLIENT 非対応時に返す形）を返す環境でも、今までどおり消す", async () => {
    const name = `mnemora-tick-last-fake-${Date.now()}`;
    const q = queueFor(name);
    const a = make(name, () => undefined);
    const b = make(name, () => undefined);
    await a.start();
    await b.start();
    vi.spyOn(Queue.prototype, "getWorkers").mockResolvedValue([
      { name: "GCP does not support client list" },
    ] as never);
    await b.stop();
    expect(await q.getJobSchedulers()).toEqual([]);
  });

  it("名前なしの Worker（ADR 0655 より前の版の driver の形）が同じ queue に居れば、stop() は scheduler を消さない", async () => {
    const name = `mnemora-tick-last-unnamed-${Date.now()}`;
    const q = queueFor(name);
    // 前の版の driver は Worker に name を付けなかった（autorun: false で作って run() する形は今と同じ）。
    const old = new Worker(name, async () => undefined, { connection, autorun: false });
    rawWorkers.push(old);
    old.run().catch(() => undefined);
    const b = make(name, () => undefined);
    await b.start();
    // 健全性: 名前なしの Worker が、本物の CLIENT LIST に `:w:` の無い接続名で出ている（接続名の設定は非同期なので待つ）。
    const unnamed = `bull:${Buffer.from(name).toString("base64")}`;
    let rawnames: unknown[] = [];
    const start = Date.now();
    while (!rawnames.includes(unnamed)) {
      if (Date.now() - start > 10_000)
        throw new Error(`名前なしの Worker が一覧に出ない: ${JSON.stringify(rawnames)}`);
      rawnames = (await q.getWorkers()).map((w) => w["rawname"]);
      await sleep(25);
    }

    await b.stop();
    expect((await q.getJobSchedulers()).length).toBe(1);
  });
});
