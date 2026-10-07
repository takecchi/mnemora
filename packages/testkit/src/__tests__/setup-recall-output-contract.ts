import { vi } from "vitest";
import type * as RuntimeModule from "../../../core/src/runtime.js";
import { failOnRuntimeOutputContractViolations } from "../../../core/src/__tests__/runtime-output-contract-harness.js";

/** core の `src/runtime.ts` のモジュールそのものを包むので、`@mnemora/core` の入口から import しても、core のテスト用の部品が相対パスで import しても、同じく包まれる。わざと契約を破らせるテストだけを、下の一覧で名前で外す。 */
const DELIBERATELY_VIOLATING_TESTS: readonly string[] = [];

vi.mock("../../../core/src/runtime.js", async (importOriginal) => {
  const { wrapRuntimeModule } =
    await import("../../../core/src/__tests__/runtime-output-contract-harness.js");
  return wrapRuntimeModule(await importOriginal<typeof RuntimeModule>());
});

failOnRuntimeOutputContractViolations(DELIBERATELY_VIOLATING_TESTS);
