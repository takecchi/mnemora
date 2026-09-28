import { afterEach, expect, vi } from "vitest";
import type * as RuntimeModule from "../runtime.js";
import type { Runtime } from "../runtime.js";

/**
 * core のすべてのテストで、`createRuntime` が返す `recall()` の戻り値を
 * `checkRecallResultContract`（`./runtime-fakes.ts`）に通す（TSDoc の7巡目 B1・B2）。
 * 破れていたら、そのテストの `afterEach` で赤にする——個々のテストが確かめ忘れても、
 * 実装が返した値が出力の schema と TSDoc の約束を守っていることを、全部の `recall()` で見る。
 *
 * ⛔ **わざと契約を破らせるテストだけを、下の一覧で名前で外す。**外すのは、呼び出し側が
 * 差せる拡張点を使って壊れた出力を作り、それが検出されること自体を確かめているテストである。
 * 一覧に足すときは、そのテストがわざと破っていることを確かめてからにすること。
 */
const DELIBERATELY_VIOLATING_TESTS: readonly string[] = [
  // recall-pipeline.test.ts「recall() — 出力検証（Issue #131、ADR 0098）」: 非整数を返す TokenCounter を差し、
  // usage.estimatedTokens の int() を破った出力を作って、検出されること・既定では投げないこと・"off" で素通りすることを確かめる。
  "T1: 契約を破った出力（usage.estimatedTokens が非整数）を検出する",
  'T4: "off" では欄そのものが無い（未検証と通過を潰さない）。値は素通りする',
  "T6: モードを渡さないとき、検証に落ちても recall() は投げない（既定は report）",
];

const problems: string[] = [];

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>();
  const { checkRecallResultContract } = await import("./runtime-fakes.js");
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
});

afterEach(() => {
  const found = problems.splice(0);
  const name = expect.getState().currentTestName ?? "";
  if (found.length === 0 || DELIBERATELY_VIOLATING_TESTS.some((t) => name.endsWith(t))) return;
  throw new Error(
    `recall() の戻り値が出力の契約を破った（${found.length} 件）:\n${[...new Set(found)].join("\n")}`,
  );
});
