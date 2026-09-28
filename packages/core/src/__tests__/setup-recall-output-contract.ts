import { vi } from "vitest";
import type * as RuntimeModule from "../runtime.js";
import { failOnRecallOutputContractViolations } from "./recall-output-contract-harness.js";

/**
 * core のすべてのテストで、`createRuntime` が返す `recall()` の戻り値を
 * `checkRecallResultContract`（`./runtime-fakes.ts`）に通す（TSDoc の7巡目 B1・B2）。
 * 配線の部品は `./recall-output-contract-harness.ts`（testkit・postgres の setup ファイルと共有）。
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

vi.mock("../runtime.js", async (importOriginal) => {
  const { wrapRuntimeModule } = await import("./recall-output-contract-harness.js");
  return wrapRuntimeModule(await importOriginal<typeof RuntimeModule>());
});

failOnRecallOutputContractViolations(DELIBERATELY_VIOLATING_TESTS);
