import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBullmqTickDriver } from "../tick-driver.js";

// `queueName` は BullMQ が同期的に投げるので、driver は検査せずそのまま渡す（`everyMs`・`jobName` は構築時に断る）。

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
    expect(upsertCalls).toEqual([
      [
        "mnemora-tick",
        { every: 100 },
        { name: "mnemora-tick", opts: { removeOnComplete: { count: 1000 } } },
      ],
    ]);
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
    expect((upsertCalls[0]?.[2] as { name: string }).name).toBe(value);
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

  // `toThrow(TypeError)` は `RangeError` を通さず、その逆も同じ（どちらも `Error` の子だが、互いの子ではない）。
  it.each([
    ["文字列 '50'", "50"],
    ["null", null],
    ["undefined", undefined],
    ["bigint", 50n],
  ])("⭐ ADR 0525: everyMs が %s（数でない）なら TypeError", (_label, value) => {
    expect(() => make({ everyMs: value })).toThrow(TypeError);
    expect(() => make({ everyMs: value })).not.toThrow(RangeError);
  });

  it.each([
    ["負", -1],
    ["0", 0],
    ["0.5", 0.5],
    ["1e21", 1e21],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["Infinity", Infinity],
    ["NaN", Number.NaN],
  ])("⭐ ADR 0525: everyMs が %s（数だが範囲外）なら RangeError", (_label, value) => {
    expect(() => make({ everyMs: value })).toThrow(RangeError);
    expect(() => make({ everyMs: value })).not.toThrow(TypeError);
  });

  it.each([
    ["数値", 1],
    ["null", null],
    ["オブジェクト", {}],
  ])("⭐ ADR 0525: jobName が %s（文字列でない）なら TypeError", (_label, value) => {
    expect(() => make({ jobName: value })).toThrow(TypeError);
    expect(() => make({ jobName: value })).not.toThrow(RangeError);
  });

  it("⭐ ADR 0525: jobName が空文字なら RangeError", () => {
    expect(() => make({ jobName: "" })).toThrow(RangeError);
    expect(() => make({ jobName: "" })).not.toThrow(TypeError);
  });

  it("⭐ ADR 0525: 型を変えても message は変わらない（文言を縛る）", () => {
    expect(() => make({ everyMs: "50" })).toThrow(
      "createBullmqTickDriver: everyMs must be a finite number between 1 and Number.MAX_SAFE_INTEGER (milliseconds), got 50",
    );
    expect(() => make({ everyMs: -1 })).toThrow(
      "createBullmqTickDriver: everyMs must be a finite number between 1 and Number.MAX_SAFE_INTEGER (milliseconds), got -1",
    );
    expect(() => make({ jobName: "" })).toThrow(
      "createBullmqTickDriver: jobName must be a non-empty string when given, got ",
    );
    expect(() => make({ jobName: 1 })).toThrow(
      "createBullmqTickDriver: jobName must be a non-empty string when given, got 1",
    );
  });

  it("⭐ ADR 0525: concurrency は、数でなければ TypeError、範囲外・小数なら RangeError", () => {
    expect(() => make({ concurrency: "2" as unknown as number })).toThrow(TypeError);
    expect(() => make({ concurrency: null as unknown as number })).toThrow(TypeError);
    expect(() => make({ concurrency: 0 })).toThrow(RangeError);
    expect(() => make({ concurrency: 1.5 })).toThrow(RangeError);
    expect(() => make({ concurrency: Number.NaN })).toThrow(RangeError);
    expect(queueCtorArgs).toHaveLength(0);
  });

  it("対照: concurrency も構築時に検査して投げる（Queue も Worker も作らない）", () => {
    expect(() => make({ concurrency: 0 })).toThrow(/concurrency must be a positive integer/);
    expect(queueCtorArgs).toHaveLength(0);
    expect(workerCtorArgs).toHaveLength(0);
  });
});

describe("ADR 0548: lockDuration と完了ジョブの保持", () => {
  function workerOpts(): Record<string, unknown> {
    return workerCtorArgs[0]?.[2] as Record<string, unknown>;
  }
  function template(): { name: string; opts: Record<string, unknown> } {
    return upsertCalls[0]?.[2] as { name: string; opts: Record<string, unknown> };
  }

  it("lockDuration を渡すと、Worker の opts にそのまま渡る（既存の opts は保つ）", () => {
    make({ lockDuration: 120_000, concurrency: 3 });
    expect(workerOpts().lockDuration).toBe(120_000);
    expect(workerOpts().concurrency).toBe(3);
    expect(workerOpts().autorun).toBe(false);
    expect(workerOpts().connection).toEqual({ host: "127.0.0.1", port: 1 });
  });

  it("lockDuration を省略（undefined も）すると、Worker の opts に lockDuration のキーを出さない（BullMQ の既定に任せる）", () => {
    make({});
    expect("lockDuration" in workerOpts()).toBe(false);
    workerCtorArgs.length = 0;
    make({ lockDuration: undefined });
    expect("lockDuration" in workerOpts()).toBe(false);
  });

  it("lockDuration: 1（下限）と MAX_SAFE_INTEGER（上限）は通る", () => {
    make({ lockDuration: 1 });
    expect(workerOpts().lockDuration).toBe(1);
    workerCtorArgs.length = 0;
    make({ lockDuration: Number.MAX_SAFE_INTEGER });
    expect(workerOpts().lockDuration).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ["文字列 '30000'", "30000"],
    ["null", null],
    ["bigint", 30000n],
    ["オブジェクト", {}],
  ])(
    "⭐ lockDuration が %s（数でない）なら TypeError。Queue も Worker も作らない",
    (_label, value) => {
      expect(() => make({ lockDuration: value })).toThrow(TypeError);
      expect(() => make({ lockDuration: value })).not.toThrow(RangeError);
      expect(() => make({ lockDuration: value })).toThrow(
        /lockDuration must be a positive integer/,
      );
      expect(queueCtorArgs).toHaveLength(0);
      expect(workerCtorArgs).toHaveLength(0);
    },
  );

  it.each([
    ["0", 0],
    ["負", -1],
    ["1.5（小数）", 1.5],
    ["0.5", 0.5],
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "⭐ lockDuration が %s（数だが範囲外）なら RangeError。Queue も Worker も作らない",
    (_label, value) => {
      expect(() => make({ lockDuration: value })).toThrow(RangeError);
      expect(() => make({ lockDuration: value })).not.toThrow(TypeError);
      expect(() => make({ lockDuration: value })).toThrow(
        /lockDuration must be a positive integer/,
      );
      expect(queueCtorArgs).toHaveLength(0);
      expect(workerCtorArgs).toHaveLength(0);
    },
  );

  it("⭐ lockDuration の message は ADR 0525 の形（`createBullmqTickDriver: <欄> must be …, got <値>`）", () => {
    expect(() => make({ lockDuration: 0 })).toThrow(
      "createBullmqTickDriver: lockDuration must be a positive integer (milliseconds), got 0",
    );
    expect(() => make({ lockDuration: "30000" })).toThrow(
      "createBullmqTickDriver: lockDuration must be a positive integer (milliseconds), got 30000",
    );
  });

  it("⭐ 検査の順序: everyMs → jobName → concurrency → lockDuration → completedJobsToKeep（先の誤りが先に出る）", () => {
    expect(() =>
      make({ everyMs: -1, jobName: "", concurrency: 0, lockDuration: 0, completedJobsToKeep: -1 }),
    ).toThrow(/everyMs must be/);
    expect(() =>
      make({ jobName: "", concurrency: 0, lockDuration: 0, completedJobsToKeep: -1 }),
    ).toThrow(/jobName must be/);
    expect(() => make({ concurrency: 0, lockDuration: 0, completedJobsToKeep: -1 })).toThrow(
      /concurrency must be/,
    );
    expect(() => make({ lockDuration: 0, completedJobsToKeep: -1 })).toThrow(
      /lockDuration must be/,
    );
    expect(() => make({ completedJobsToKeep: -1 })).toThrow(/completedJobsToKeep must be/);
  });

  it("⭐ 完了ジョブの保持の既定は removeOnComplete: { count: 1000 }。removeOnFail は触らない", async () => {
    const driver = make({});
    await driver.start();
    expect(template().opts).toEqual({ removeOnComplete: { count: 1000 } });
    expect("removeOnFail" in template().opts).toBe(false);
  });

  it("completedJobsToKeep で既定を上書きできる（removeOnFail は触らない）", async () => {
    const driver = make({ completedJobsToKeep: 50 });
    await driver.start();
    expect(template().name).toBe("mnemora-tick");
    expect(template().opts).toEqual({ removeOnComplete: { count: 50 } });
    expect("removeOnFail" in template().opts).toBe(false);
  });

  it("completedJobsToKeep: 0（完了したらすぐ消す）と MAX_SAFE_INTEGER（実質すべて残す）は通る", async () => {
    await make({ completedJobsToKeep: 0 }).start();
    expect(template().opts).toEqual({ removeOnComplete: { count: 0 } });
    upsertCalls.length = 0;
    await make({ completedJobsToKeep: Number.MAX_SAFE_INTEGER }).start();
    expect(template().opts).toEqual({ removeOnComplete: { count: Number.MAX_SAFE_INTEGER } });
  });

  it("completedJobsToKeep が undefined なら既定（1000）", async () => {
    await make({ completedJobsToKeep: undefined }).start();
    expect(template().opts).toEqual({ removeOnComplete: { count: 1000 } });
  });

  it.each([
    ["文字列 '10'", "10"],
    ["null", null],
    ["bigint", 10n],
    ["真偽値", true],
  ])(
    "⭐ completedJobsToKeep が %s（数でない）なら TypeError。Queue も Worker も作らない",
    (_label, value) => {
      expect(() => make({ completedJobsToKeep: value })).toThrow(TypeError);
      expect(() => make({ completedJobsToKeep: value })).not.toThrow(RangeError);
      expect(queueCtorArgs).toHaveLength(0);
      expect(workerCtorArgs).toHaveLength(0);
    },
  );

  it.each([
    ["負", -1],
    ["1.5（小数）", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "⭐ completedJobsToKeep が %s（数だが範囲外）なら RangeError。Queue も Worker も作らない",
    (_label, value) => {
      expect(() => make({ completedJobsToKeep: value })).toThrow(RangeError);
      expect(() => make({ completedJobsToKeep: value })).not.toThrow(TypeError);
      expect(queueCtorArgs).toHaveLength(0);
      expect(workerCtorArgs).toHaveLength(0);
    },
  );

  it("⭐ completedJobsToKeep の message は ADR 0525 の形", () => {
    expect(() => make({ completedJobsToKeep: -1 })).toThrow(
      "createBullmqTickDriver: completedJobsToKeep must be a non-negative integer, got -1",
    );
  });

  // opts を丸ごと `toEqual` で固定する。`removeOnFail` が入ると失敗したジョブが消えうるため。
  const CONNECTION = { host: "127.0.0.1", port: 1 };

  it("⭐ Worker の opts は丸ごと固定（lockDuration あり）。removeOnComplete・removeOnFail・stalledInterval などの余計なキーを許さない", () => {
    make({ lockDuration: 120_000 });
    expect(workerOpts()).toEqual({
      connection: CONNECTION,
      concurrency: 1,
      name: expect.stringMatching(/^mnemora-tick-[0-9a-f-]{36}$/),
      autorun: false,
      lockDuration: 120_000,
    });
  });

  it("⭐ Worker の opts は丸ごと固定（lockDuration なし）。lockDuration のキーも出さない", () => {
    make({});
    expect(workerOpts()).toEqual({
      connection: CONNECTION,
      concurrency: 1,
      name: expect.stringMatching(/^mnemora-tick-[0-9a-f-]{36}$/),
      autorun: false,
    });
  });

  it("⭐ Queue の opts は { connection } だけ。defaultJobOptions（removeOnFail・removeOnComplete）も lockDuration も載せない", () => {
    make({ lockDuration: 120_000, completedJobsToKeep: 50 });
    expect(queueCtorArgs[0]?.[1]).toEqual({ connection: CONNECTION });
    queueCtorArgs.length = 0;
    make({});
    expect(queueCtorArgs[0]?.[1]).toEqual({ connection: CONNECTION });
  });

  it("⭐ lockDuration と completedJobsToKeep を同時に渡すと、それぞれの行き先にだけ届く", async () => {
    await make({ lockDuration: 90_000, completedJobsToKeep: 7, concurrency: 2 }).start();
    expect(workerOpts()).toEqual({
      connection: CONNECTION,
      concurrency: 2,
      name: expect.stringMatching(/^mnemora-tick-[0-9a-f-]{36}$/),
      autorun: false,
      lockDuration: 90_000,
    });
    expect(queueCtorArgs[0]?.[1]).toEqual({ connection: CONNECTION });
    expect(upsertCalls).toEqual([
      [
        "mnemora-tick",
        { every: 100 },
        { name: "mnemora-tick", opts: { removeOnComplete: { count: 7 } } },
      ],
    ]);
  });
});
