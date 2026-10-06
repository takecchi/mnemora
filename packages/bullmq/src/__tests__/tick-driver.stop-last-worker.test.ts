import { beforeEach, describe, expect, it, vi } from "vitest";

// Redis を要らない検査（`bullmq` の `Queue`/`Worker` を丸ごとモックに差し替える）。
// ADR 0655 の `stop()` の分岐——`queue.getWorkers()` の返り値から「自分以外の Worker が居るか」を読み、
// 居なければ（または分からなければ）共有の scheduler を消す——を、返り値の形ごとに縛る（Issue #1752）。
// 本物の Redis での振る舞いは `tick-driver.stop-last-worker.redis.test.ts`（`test:redis`）が見ている。
// こちらは Redis の無いジョブでも走り、分岐の取り違え（常に消す・偽の1件を「他」と読む・自分を「他」と読む・
// 「他が居る」を行の数で読む）を落とす。

interface MockQueueInstance {
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  removeJobScheduler: ReturnType<typeof vi.fn>;
  getWorkers: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockWorkerInstance {
  opts: { name?: string };
  close: ReturnType<typeof vi.fn>;
}

const queueInstances: MockQueueInstance[] = [];
const workerInstances: MockWorkerInstance[] = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    getWorkers = vi.fn().mockResolvedValue([]);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
    constructor(..._args: unknown[]) {
      queueInstances.push(this);
    }
  }
  class Worker {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    opts: { name?: string };
    constructor(_name: string, _processor: unknown, opts: { name?: string }) {
      this.opts = opts;
      workerInstances.push(this);
    }
  }
  return { Queue, Worker };
});

const { createBullmqTickDriver } = await import("../tick-driver.js");

beforeEach(() => {
  queueInstances.length = 0;
  workerInstances.length = 0;
});

/** bullmq の接続名の形（`<prefix>:<base64(queue)>` と、名前付きの Worker は `:w:<name>` が続く）。 */
const BASE = `bull:${Buffer.from("mnemora-tick-test").toString("base64")}`;

function makeDriver() {
  const driver = createBullmqTickDriver({
    connection: {},
    queueName: "mnemora-tick-test",
    runtime: { tick: vi.fn() },
    ctx: { tenantId: "t1" },
    tick: { leaseMs: 1000 },
    everyMs: 1000,
  });
  const queue = queueInstances.at(-1)!;
  const selfName = workerInstances.at(-1)!.opts.name;
  // 健全性: 自分の Worker に名前が付いていること（自分を一覧から見分ける手がかり）。
  expect(selfName).toMatch(/^mnemora-tick-/);
  return { driver, queue, selfRawname: `${BASE}:w:${selfName!}` };
}

describe("createBullmqTickDriver().stop() は、getWorkers() の返り値に応じて共有 scheduler を消すかを決める（ADR 0655）", () => {
  it("一覧が自分だけなら消す（最後の1台）", async () => {
    const { driver, queue, selfRawname } = makeDriver();
    queue.getWorkers.mockResolvedValueOnce([{ name: "x", rawname: selfRawname }]);
    await driver.stop();
    expect(queue.getWorkers).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
  });

  it("一覧が空なら消す（自分の接続名が出ない環境）", async () => {
    const { driver, queue } = makeDriver();
    queue.getWorkers.mockResolvedValueOnce([]);
    await driver.stop();
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
  });

  it("自分のほかに名前付きの Worker が居れば消さない", async () => {
    const { driver, queue, selfRawname } = makeDriver();
    queue.getWorkers.mockResolvedValueOnce([
      { name: "a", rawname: selfRawname },
      { name: "b", rawname: `${BASE}:w:mnemora-tick-other` },
    ]);
    await driver.stop();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
    // 消さなくても、自分の資源は閉じる。
    expect(workerInstances.at(-1)!.close).toHaveBeenCalledTimes(1);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("名前なしの Worker（`:w:` の無い接続名）も「他」と数え、消さない", async () => {
    const { driver, queue, selfRawname } = makeDriver();
    queue.getWorkers.mockResolvedValueOnce([
      { name: "a", rawname: selfRawname },
      { name: "b", rawname: BASE },
    ]);
    await driver.stop();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("自分の名前を前置きに含むだけの別の Worker は「他」と数え、消さない（末尾一致で自分を見分ける）", async () => {
    const { driver, queue, selfRawname } = makeDriver();
    queue.getWorkers.mockResolvedValueOnce([
      { name: "a", rawname: selfRawname },
      { name: "b", rawname: `${selfRawname}-2` },
    ]);
    await driver.stop();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("一覧に自分が出ていなくても、他の Worker が1件居れば消さない（「他が居る」は行の数ではなく、自分以外の行の有無で決める）", async () => {
    const { driver, queue } = makeDriver();
    // 自分の行が無いのは、自分の blocking 接続が `stop()` の時点で切れている（再接続中など）とき。
    // 「2行以上なら他が居る」と数で読むと、ここで消して他の driver の tick を止める（Issue #1758 の M05）。
    queue.getWorkers.mockResolvedValueOnce([
      { name: "b", rawname: `${BASE}:w:mnemora-tick-other` },
    ]);
    await driver.stop();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("rawname の無い偽の1件（CLIENT が未対応の環境）は「他」と読まず、消す", async () => {
    const { driver, queue } = makeDriver();
    queue.getWorkers.mockResolvedValueOnce([{ name: "GCP does not support client list" }]);
    await driver.stop();
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
  });

  it("getWorkers() が throw したら、居るか分からないので消す", async () => {
    const { driver, queue } = makeDriver();
    queue.getWorkers.mockRejectedValueOnce(new Error("ERR unknown command 'CLIENT'"));
    await driver.stop();
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
  });

  it("getWorkers() は自分の Worker を閉じる前に読む（閉じた後に読むと、自分の除外が要らない形にすり替わる）", async () => {
    const { driver, queue, selfRawname } = makeDriver();
    const worker = workerInstances.at(-1)!;
    const order: string[] = [];
    queue.getWorkers.mockImplementationOnce(async () => {
      order.push("getWorkers");
      return [{ name: "a", rawname: selfRawname }];
    });
    worker.close.mockImplementationOnce(async () => {
      order.push("worker.close");
    });
    await driver.stop();
    expect(order).toEqual(["getWorkers", "worker.close"]);
  });
});
