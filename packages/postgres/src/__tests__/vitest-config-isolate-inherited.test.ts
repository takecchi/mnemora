import { describe, expect, it } from "vitest";
import config from "../../vitest.config.mjs";
import { SERIAL_PROJECT_NAME } from "./worker-database.js";

// `vitest-config-isolate.test.ts` は project 自身の `isolate` だけを見る。ルートの `test.isolate` が `false` にされても
// 直列 project には何も書かれないまま実効値が変わるので、継承も込みで見る（ADR 0397）。
type TestCfg = { isolate?: unknown; name?: unknown };
type Cfg = { test?: TestCfg & { projects?: Array<{ extends?: unknown; test?: TestCfg }> } };

describe("vitest.config.mts の isolate（ルートからの引き継ぎ。ADR 0397）", () => {
  it("直列 project の実効の isolate は false でない（自身に無ければ、ルートの値を引き継ぐ）", () => {
    const root = (config as Cfg).test;
    const project = root?.projects?.find((p) => p.test?.name === SERIAL_PROJECT_NAME);
    expect(project, `project "${SERIAL_PROJECT_NAME}" が無い`).toBeDefined();
    const own = project?.test?.isolate;
    const effective =
      own !== undefined ? own : project?.extends === true ? root?.isolate : undefined;
    expect(
      effective,
      "直列 project の実効の isolate が false になっている（ルートの test.isolate を引き継いでいないか）。ADR 0397 を変えるなら、この歯も直すこと",
    ).not.toBe(false);
  });
});
