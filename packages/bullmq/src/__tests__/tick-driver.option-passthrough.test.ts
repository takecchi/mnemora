import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBullmqTickDriver } from "../tick-driver.js";

// ADR 0477（検査を足す直しは ADR 0498）: `everyMs`・`jobName` は構築時に検査して断る。`queueName` は BullMQ が
// 同期的に投げるので driver は検査せずそのまま渡す。この歯は Redis の要らない形（`bullmq` を丸ごとモックに
// 差し替える）で、(1) 断る入力は `Queue`・`Worker` を作る前に投げること、(2) 正当な入力はそのまま渡ることを縛る。
// 検査を外すと (1) が赤、正当な入力まで断ると (2) が赤になる。
// 実 Redis で BullMQ が止まる様子（負・1 未満・1e21 の everyMs、空の jobName）は ADR 0477 に表で書いてある。
// `concurrency` は `resolveConcurrency` が検査する（`tick-driver.test.ts`）。

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

describe("createBullmqTickDriver: everyMs・jobName は構築時に検査し、queueName は検査せず渡す（ADR 0498）", () => {
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
    ["0.5（1 未満の小数）", 0.5],
    ["0", 0],
    ["1e21", 1e21],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["NaN", Number.NaN],
    ["文字列 '50'", "50"],
    ["null", null],
    ["undefined", undefined],
    ["bigint", 50n],
  ])("⭐ everyMs が %s なら、構築時に投げ、Queue も Worker も作らない", (_label, value) => {
    expect(() => make({ everyMs: value })).toThrow(/everyMs must be/);
    expect(queueCtorArgs).toHaveLength(0);
    expect(workerCtorArgs).toHaveLength(0);
  });

  it.each([
    ["1（下限）", 1],
    ["1.5（小数は通す）", 1.5],
    ["5000", 5000],
    ["2^31（BullMQ が受ける大きい値）", 2 ** 31],
    ["MAX_SAFE_INTEGER（上限）", Number.MAX_SAFE_INTEGER],
  ])("everyMs が %s なら通り、BullMQ の `every` にそのまま渡す", async (_label, value) => {
    const driver = make({ everyMs: value });
    await driver.start();
    const repeat = upsertCalls[0]?.[1] as { every: unknown };
    expect(Object.is(repeat.every, value)).toBe(true);
  });

  it.each([
    ["空文字", ""],
    ["数値", 1],
    ["null", null],
    ["オブジェクト", {}],
  ])("⭐ jobName が %s なら、構築時に投げ、Queue も Worker も作らない", (_label, value) => {
    expect(() => make({ jobName: value })).toThrow(/jobName must be/);
    expect(queueCtorArgs).toHaveLength(0);
    expect(workerCtorArgs).toHaveLength(0);
  });

  it.each([
    ["空白", " "],
    ["`:` を含む", "a:b"],
    ["日本語", "ジョブ"],
    ["300 文字", "j".repeat(300)],
  ])("jobName が %s なら通り、scheduler の id と name にそのまま渡す", async (_label, value) => {
    const driver = make({ jobName: value });
    await driver.start();
    expect(upsertCalls[0]?.[0]).toBe(value);
    expect(upsertCalls[0]?.[2]).toEqual({ name: value });
  });

  it("jobName が undefined なら既定の mnemora-tick になる", async () => {
    const driver = make({ jobName: undefined });
    await driver.start();
    expect(upsertCalls[0]?.[0]).toBe("mnemora-tick");
  });

  it.each([
    ["空白", " "],
    ["日本語", "キュー"],
    ["300 文字", "q".repeat(300)],
  ])(
    "queueName が %s でも、driver は検査せず Queue と Worker にそのまま渡す（BullMQ が自分で断る）",
    (_label, value) => {
      make({ queueName: value });
      expect(queueCtorArgs[0]?.[0]).toBe(value);
      expect(workerCtorArgs[0]?.[0]).toBe(value);
    },
  );

  it("対照: concurrency も構築時に検査して投げる（Queue も Worker も作らない）", () => {
    expect(() => make({ concurrency: 0 })).toThrow(/concurrency must be a positive integer/);
    expect(queueCtorArgs).toHaveLength(0);
    expect(workerCtorArgs).toHaveLength(0);
  });
});
