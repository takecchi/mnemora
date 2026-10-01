import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBullmqTickDriver } from "../tick-driver.js";

// ADR 0477: `everyMs`・`jobName`・`queueName` は driver 自身は検査せず、BullMQ にそのまま渡す。
// この歯は「そのまま渡す」今の振る舞いを、Redis の要らない形（`bullmq` を丸ごとモックに差し替える）で縛る。
// BullMQ 側がそれをどう扱うか（0 や NaN は `start()` が reject、負・小数・1e21 は黙って数回で止まる、など）は
// 実 Redis での測定値で、ADR 0477 に表で書いてある。**誰かが driver に検査を足したら、この歯が赤になる**
// ——その場合は ADR 0477（検査を足すのは新しく断る入力）と README の該当の節を読み直すこと。
// 対する `concurrency` は `resolveConcurrency` が検査する（`tick-driver.test.ts`）。その非対称もここで縛る。

const queueCtorArgs: unknown[][] = [];
const workerCtorArgs: unknown[][] = [];
const upsertCalls: unknown[][] = [];

vi.mock("bullmq", () => {
  class Queue {
    upsertJobScheduler = vi.fn().mockImplementation((...args: unknown[]) => {
      upsertCalls.push(args);
      return Promise.resolve(undefined);
    });
    removeJobScheduler = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    on = vi.fn().mockReturnThis();
    constructor(...args: unknown[]) {
      queueCtorArgs.push(args);
    }
  }
  class Worker {
    on = vi.fn();
    run = vi.fn().mockImplementation(() => new Promise(() => {}));
    close = vi.fn().mockResolvedValue(undefined);
    emit = vi.fn();
    constructor(...args: unknown[]) {
      workerCtorArgs.push(args);
    }
  }
  return { Queue, Worker };
});

beforeEach(() => {
  queueCtorArgs.length = 0;
  workerCtorArgs.length = 0;
  upsertCalls.length = 0;
});

function make(over: Record<string, unknown>) {
  return createBullmqTickDriver({
    connection: { host: "127.0.0.1", port: 1 },
    queueName: "q",
    runtime: {
      tick: async () => ({ processed: 0, failed: 0, unsupported: [], leaseConflicts: [] }),
    },
    ctx: { tenantId: "t" },
    tick: { leaseMs: 1000 },
    everyMs: 100,
    ...over,
  } as never);
}

describe("createBullmqTickDriver: everyMs・jobName・queueName は検査せずそのまま渡す（ADR 0477）", () => {
  it("陽性対照: 普通の値はそのまま渡る（jobName の既定は mnemora-tick）", async () => {
    const driver = make({});
    await driver.start();
    expect(upsertCalls).toEqual([["mnemora-tick", { every: 100 }, { name: "mnemora-tick" }]]);
    expect(queueCtorArgs[0]?.[0]).toBe("q");
    expect(workerCtorArgs[0]?.[0]).toBe("q");
  });

  it.each([
    ["負", -1],
    ["負の大きい値", -100],
    ["0.5", 0.5],
    ["小数 1.5", 1.5],
    ["1e21", 1e21],
    ["2^53 超", 9007199254740994],
    ["Infinity", Infinity],
    ["0", 0],
    ["NaN", Number.NaN],
    ["文字列 '50'", "50"],
  ])(
    "⭐ everyMs が %s でも、driver は投げず、BullMQ の `every` にそのまま渡す",
    async (_label, value) => {
      const driver = make({ everyMs: value });
      await driver.start();
      expect(upsertCalls).toHaveLength(1);
      const repeat = upsertCalls[0]?.[1] as { every: unknown };
      expect(Object.is(repeat.every, value)).toBe(true);
    },
  );

  it.each([
    ["空文字", ""],
    ["空白", " "],
    ["`:` を含む", "a:b"],
    ["日本語", "ジョブ"],
    ["300 文字", "j".repeat(300)],
  ])(
    "⭐ jobName が %s でも、driver は投げず、scheduler の id と name にそのまま渡す",
    async (_label, value) => {
      const driver = make({ jobName: value });
      await driver.start();
      expect(upsertCalls[0]?.[0]).toBe(value);
      expect(upsertCalls[0]?.[2]).toEqual({ name: value });
    },
  );

  it.each([
    ["空白", " "],
    ["日本語", "キュー"],
    ["300 文字", "q".repeat(300)],
  ])(
    "⭐ queueName が %s でも、driver は検査せず Queue と Worker にそのまま渡す",
    (_label, value) => {
      make({ queueName: value });
      expect(queueCtorArgs[0]?.[0]).toBe(value);
      expect(workerCtorArgs[0]?.[0]).toBe(value);
    },
  );

  it("非対称の対照: concurrency は構築時に検査して投げる（Queue も Worker も作らない）", () => {
    expect(() => make({ concurrency: 0 })).toThrow(/concurrency must be a positive integer/);
    expect(queueCtorArgs).toHaveLength(0);
    expect(workerCtorArgs).toHaveLength(0);
  });
});
