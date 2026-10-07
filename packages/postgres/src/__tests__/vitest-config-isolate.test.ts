import { describe, expect, it } from "vitest";
import config from "../../vitest.config.mjs";
import { PARALLEL_PROJECT_NAME, SERIAL_PROJECT_NAME } from "./worker-database.js";

/**
 * `packages/postgres` の DB テストの `isolate` の決めごと（[ADR 0397](../../../../docs/decisions/0397-postgres-db-tests-isolate-false.md)）を
 * 守る歯。
 *
 * ADR 0397 は、並列 project だけを `isolate: false` にし、直列 project は `isolate: true`（既定）のまま
 * にすると決めた。並列の側を `true` に戻しても、直列の側を `false` にしても、ほかのテストは緑のまま
 * ——前者は遅くなるだけ、後者は接続切断・プール終了を見るテストに状態が持ち越されうるだけで、
 * どちらも黙って起きる。この歯は、その設定値そのものを見る。
 *
 * ⚠ **ADR 0397 を変えるなら、この歯も直すこと。** 設定値を固定する歯なので、決めごとを変えると赤になる。
 */

type ProjectTest = { name?: unknown; isolate?: unknown };

function projectTest(name: string): ProjectTest {
  const projects = (config as { test?: { projects?: Array<{ test?: ProjectTest }> } }).test
    ?.projects;
  const found = projects?.find((p) => p.test?.name === name)?.test;
  if (found === undefined) {
    throw new Error(
      `vitest.config.mts に project "${name}" が無い。ADR 0397 を変えるなら、この歯も直すこと`,
    );
  }
  return found;
}

describe("vitest.config.mts の isolate（ADR 0397）", () => {
  it("並列 project は isolate: false", () => {
    expect(
      projectTest(PARALLEL_PROJECT_NAME).isolate,
      "並列 project の isolate が false でない。ADR 0397 を変えるなら、この歯も直すこと",
    ).toBe(false);
  });

  it("直列 project は isolate を false にしない（既定の true のまま）", () => {
    expect(
      projectTest(SERIAL_PROJECT_NAME).isolate,
      "直列 project の isolate が false になっている。ADR 0397 を変えるなら、この歯も直すこと",
    ).not.toBe(false);
  });
});
