import { afterEach, expect } from "vitest";
import type * as RuntimeModule from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { checkRecallResultContract } from "./runtime-fakes.js";

/**
 * `recall()` の戻り値の契約の検査（`checkRecallResultContract`、`./runtime-fakes.ts`）を、テストの一式全体に
 * 配線するための部品（TSDoc の7巡目 B1・B2）。core・testkit・postgres の setup ファイルが共有する。
 *
 * 使い方（setup ファイルで）:
 * 1. `vi.mock(<core の src/runtime.ts へのパス>, async (importOriginal) => wrapRuntimeModule(await importOriginal()))`
 *    で、`createRuntime` が返す `recall` を包む。`@mnemora/core` の入口も core の `src/runtime.ts` を
 *    再 export しているので、入口から import しても、相対パスで import しても、同じく包まれる。
 * 2. `failOnRecallOutputContractViolations(除外の一覧)` で、破れていたらそのテストの `afterEach` で赤にする。
 */

const problems: string[] = [];

/** `createRuntime` が返す `recall` を包み、戻り値を検査して破れた点を溜める。 */
export function wrapRuntimeModule(actual: typeof RuntimeModule): typeof RuntimeModule {
  return {
    ...actual,
    createRuntime: (...args: Parameters<typeof actual.createRuntime>): Runtime => {
      const runtime = actual.createRuntime(...args);
      const recall = runtime.recall.bind(runtime);
      runtime.recall = async (...recallArgs) => {
        const result = await recall(...recallArgs);
        problems.push(...checkRecallResultContract(result));
        return result;
      };
      return runtime;
    },
  };
}

/**
 * 溜まった破れを、そのテストの `afterEach` で赤にする。
 *
 * ⛔ **`deliberatelyViolatingTests` には、わざと契約を破らせるテストだけを、名前（`it` の名前の末尾一致）で置く。**
 */
export function failOnRecallOutputContractViolations(
  deliberatelyViolatingTests: readonly string[],
): void {
  afterEach(() => {
    const found = problems.splice(0);
    const name = expect.getState().currentTestName ?? "";
    if (found.length === 0 || deliberatelyViolatingTests.some((t) => name.endsWith(t))) return;
    throw new Error(
      `recall() の戻り値が出力の契約を破った（${found.length} 件）:\n${[...new Set(found)].join("\n")}`,
    );
  });
}
