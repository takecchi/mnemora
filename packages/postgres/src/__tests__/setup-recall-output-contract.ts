import { vi } from "vitest";
import type * as RuntimeModule from "../../../core/src/runtime.js";
import { failOnRuntimeOutputContractViolations } from "../../../core/src/__tests__/runtime-output-contract-harness.js";

/**
 * このパッケージのすべてのテストで、`createRuntime` が返す `Runtime` の各メソッドの戻り値を、core と同じ検査に通す
 * （`recall()` は `checkRecallResultContract`〔`packages/core/src/__tests__/runtime-fakes.ts`〕、
 * それ以外の16メソッドは `packages/core/src/__tests__/runtime-return-contract.ts` の `checkXxxContract`）。
 * 配線の部品は core の `src/__tests__/runtime-output-contract-harness.ts` を共有する（コピーしない）。
 *
 * core の `src/runtime.ts` のモジュールそのものを包むので、`@mnemora/core` の入口から import しても
 * （vitest の alias で core の `src` を指す）、core のテスト用の部品が相対パスで import しても、同じく包まれる。
 *
 * ⛔ わざと契約を破らせるテストだけを、下の一覧で名前で外す（core の setup ファイルと同じ作法）。
 */
const DELIBERATELY_VIOLATING_TESTS: readonly string[] = [];

vi.mock("../../../core/src/runtime.js", async (importOriginal) => {
  const { wrapRuntimeModule } =
    await import("../../../core/src/__tests__/runtime-output-contract-harness.js");
  return wrapRuntimeModule(await importOriginal<typeof RuntimeModule>());
});

failOnRuntimeOutputContractViolations(DELIBERATELY_VIOLATING_TESTS);
