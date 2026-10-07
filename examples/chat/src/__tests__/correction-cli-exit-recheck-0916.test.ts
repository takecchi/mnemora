import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CorrectionDemoModule from "../correction-demo.js";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";

/**
 * `cli.ts` は import しただけで `main()` を走らせる。DB も実デモも要らない形にするため、ランタイムの生成とデモの本体・検査だけを差し替え、
 * dispatch 行・終了コード・標準エラーの書き分けだけを実物の `cli.ts` で見る。
 * 検査関数を実物のまま使わないのは、「1欄だけ false」を作るのに実 DB の細工が要るため。実物との結合は CI の `correction` の段が見る。
 */

const DEMO_FIELDS = [
  "markSucceeded",
  "resolveSucceeded",
  "afterMarkBothPresent",
  "afterMarkCompanionRetrieval",
  "afterMarkCompanionOfOther",
  "afterResolveOriginalAbsent",
  "afterResolveCorrectionPresent",
] as const;
const OMISSION_FIELD = "afterResolveOriginalOmittedAsSuperseded";

type Fields = Record<string, boolean>;

const state = vi.hoisted(() => ({
  outcome: "resolved" as string,
  demoChecks: {} as Record<string, boolean>,
  omissionChecks: {} as Record<string, boolean>,
  close: undefined as undefined | (() => Promise<void>),
  runCorrectionDemo: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  checkCalls: 0,
}));

vi.mock("../runtime-factory.js", () => ({
  createExampleRuntime: async () => ({
    runtime: {},
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    cassetteIgnored: false,
    close: () => state.close?.(),
  }),
}));

vi.mock("../correction-demo.js", async (importOriginal) => {
  const original = await importOriginal<typeof CorrectionDemoModule>();
  return {
    ...original,
    runCorrectionDemo: (...args: unknown[]) => state.runCorrectionDemo?.(...args),
    formatCorrectionDemo: () => "(demo output)",
    checkCorrectionDemo: () => {
      state.checkCalls += 1;
      return state.demoChecks;
    },
    checkCorrectionOmission: () => state.omissionChecks,
  };
});

function allTrue(): { demo: Fields; omission: Fields } {
  return {
    demo: Object.fromEntries(DEMO_FIELDS.map((name) => [name, true])),
    omission: { [OMISSION_FIELD]: true },
  };
}

interface CliRun {
  exitCode: typeof process.exitCode;
  stdout: string;
  stderr: string;
  closeCalls: number;
  demoArgs: unknown[][];
}

async function runCorrectionCommand(
  demo: Fields,
  omission: Fields,
  outcome = "resolved",
): Promise<CliRun> {
  state.outcome = outcome;
  state.demoChecks = demo;
  state.omissionChecks = omission;
  state.checkCalls = 0;
  const demoArgs: unknown[][] = [];
  state.runCorrectionDemo = async (...args) => {
    demoArgs.push(args);
    return { outcome: state.outcome };
  };
  let closeCalls = 0;
  const finished = new Promise<void>((resolve) => {
    state.close = async () => {
      closeCalls += 1;
      resolve();
    };
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(a.join(" ")));
  process.exitCode = undefined;
  process.argv = ["node", "cli.ts", "correction"];
  vi.resetModules();
  await import("../cli.js");
  // dispatch 行が無いと `close()` に到達せず永久に待つので、待ちには上限を付けて、赤にする。
  let giveUp: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    giveUp = setTimeout(
      () => reject(new Error("correction サブコマンドが dispatch されなかった")),
      5_000,
    );
  });
  try {
    await Promise.race([finished, gaveUp]);
  } finally {
    clearTimeout(giveUp);
  }
  // `close()` の後ろ（`finally` を抜けて `main()` が閉じる）まで1周待つ。
  await new Promise((resolve) => setImmediate(resolve));
  return {
    exitCode: process.exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    closeCalls,
    demoArgs,
  };
}

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://stub-for-correction-cli-test";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("cli.ts の correction サブコマンドは、検査の赤を終了コードで伝える", () => {
  it("全欄が true なら終了コードは 0 のままで、全て通ったと言い、標準エラーは空である", async () => {
    const { demo, omission } = allTrue();
    const run = await runCorrectionCommand(demo, omission);
    expect(run.exitCode ?? 0).toBe(0);
    expect(run.stdout).toContain("✔ correction デモの検査が全て通った(8件");
    expect(run.stderr).toBe("");
    expect(run.closeCalls).toBe(1);
  });

  it("dispatch 行が correction デモの本体を1回だけ呼び、記録済みの採用者の指名を渡す", async () => {
    const { demo, omission } = allTrue();
    const run = await runCorrectionCommand(demo, omission);
    expect(run.demoArgs).toHaveLength(1);
    const [, ctx, scenario, choice] = run.demoArgs[0] as [
      unknown,
      { tenantId: string },
      unknown,
      unknown,
    ];
    expect(ctx.tenantId).toMatch(/^example-chat-correction-\d+$/);
    expect(scenario).toEqual(CORRECTION_SCENARIO);
    expect(choice).toEqual({ chosenExternalId: CORRECTION_SCENARIO.contestedPair.firstExternalId });
  });

  it.each([...DEMO_FIELDS, OMISSION_FIELD])(
    "%s だけが false でも、その欄を名指しして終了コード 1 になり、「通った」とは言わない",
    async (failing) => {
      const { demo, omission } = allTrue();
      if (failing === OMISSION_FIELD) {
        omission[failing] = false;
      } else {
        demo[failing] = false;
      }
      const run = await runCorrectionCommand(demo, omission);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("🔴 correction デモの検査が 1/8 件 失敗した");
      expect(run.stderr).toContain(failing);
      expect(run.stdout).not.toContain("✔");
      expect(run.closeCalls).toBe(1);
    },
  );

  it("複数の欄が false なら、全ての欄を名指しする（先頭の1欄で打ち切らない）", async () => {
    const { demo, omission } = allTrue();
    demo.afterResolveOriginalAbsent = false;
    demo.markSucceeded = false;
    omission[OMISSION_FIELD] = false;
    const run = await runCorrectionCommand(demo, omission);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("3/8 件");
    for (const name of ["markSucceeded", "afterResolveOriginalAbsent", OMISSION_FIELD]) {
      expect(run.stderr).toContain(name);
    }
  });

  it("デモが resolved まで進まなかったときは、検査に進まず outcome を名指しして終了コード 1 になる", async () => {
    const { demo, omission } = allTrue();
    const run = await runCorrectionCommand(demo, omission, "candidates_missing");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('outcome="candidates_missing"');
    expect(run.stdout).not.toContain("✔");
    expect(state.checkCalls).toBe(0);
    expect(run.closeCalls).toBe(1);
  });
});
