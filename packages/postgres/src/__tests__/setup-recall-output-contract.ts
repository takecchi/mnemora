import { vi } from "vitest";
import type * as RuntimeModule from "../../../core/src/runtime.js";
import { failOnRecallOutputContractViolations } from "../../../core/src/__tests__/recall-output-contract-harness.js";

/**
 * このパッケージのすべてのテストで、`createRuntime` が返す `recall()` の戻り値を、core と同じ
 * `checkRecallResultContract`（`packages/core/src/__tests__/runtime-fakes.ts`）に通す（TSDoc の7巡目 B1・B2）。
 * 配線の部品は core の `src/__tests__/recall-output-contract-harness.ts` を共有する（コピーしない）。
 *
 * core の `src/runtime.ts` のモジュールそのものを包むので、`@mnemora/core` の入口から import しても
 * （vitest の alias で core の `src` を指す）、core のテスト用の部品が相対パスで import しても、同じく包まれる。
 *
 * ⛔ わざと契約を破らせるテストだけを、下の一覧で名前で外す（core の setup ファイルと同じ作法）。
 */
const DELIBERATELY_VIOLATING_TESTS: readonly string[] = [];

vi.mock("../../../core/src/runtime.js", async (importOriginal) => {
  const { wrapRuntimeModule } =
    await import("../../../core/src/__tests__/recall-output-contract-harness.js");
  return wrapRuntimeModule(await importOriginal<typeof RuntimeModule>());
});

failOnRecallOutputContractViolations(DELIBERATELY_VIOLATING_TESTS);
