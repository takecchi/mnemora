import { vi } from "vitest";
import type * as RuntimeModule from "../runtime.js";
import { failOnRuntimeOutputContractViolations } from "./runtime-output-contract-harness.js";

/**
 * core のすべてのテストで、`createRuntime` が返す `Runtime` の各メソッドの戻り値を検査に通す
 * （`recall()` は `checkRecallResultContract`〔`./runtime-fakes.ts`〕、それ以外は `./runtime-return-contract.ts` の `checkXxxContract`）。
 * 配線の部品は `./runtime-output-contract-harness.ts`（testkit・postgres の setup ファイルと共有）。
 *
 * ⛔ わざと契約を破らせるテストだけを、下の一覧で名前で外す。外すのは、呼び出し側が差せる拡張点を使って
 * 壊れた出力を作り、それが検出されること自体を確かめているテストである。
 * 一覧に足すときは、そのテストがわざと破っていることを確かめてからにすること。
 */
const DELIBERATELY_VIOLATING_TESTS: readonly string[] = [
  // recall-pipeline.test.ts「recall() — 出力検証」: 非整数を返す TokenCounter を差し、usage.estimatedTokens の int() を破った出力を作って、
  // 検出されること・既定では投げないこと・"off" で素通りすることを確かめる。
  "T1: 契約を破った出力（usage.estimatedTokens が非整数）を検出する",
  'T4: "off" では欄そのものが無い（未検証と通過を潰さない）。値は素通りする',
  "T6: モードを渡さないとき、検証に落ちても recall() は投げない（既定は report）",
  // counter の欄が壊れた TokenCounter を差し、usage.counter に素通しされることを縛る歯。
  // 小数は通す（recall() は断らない）。ただし usage.estimatedTokens の int() は破るので、outputValidation が知らせる。
  "やりすぎない: 小数 0.5 を返す counter は通る（有限で 0 以上なら整数でなくてよい）",
  "counter の欄が無い: tokens が正常なら通り、値はそのまま usage.counter に出て、検証で知らされる（ADR 0483 のまま。ADR 0497 の対象外）",
  "counter が範囲外の文字列: tokens が正常なら通り、値はそのまま usage.counter に出て、検証で知らされる（ADR 0483 のまま。ADR 0497 の対象外）",
];

vi.mock("../runtime.js", async (importOriginal) => {
  const { wrapRuntimeModule } = await import("./runtime-output-contract-harness.js");
  return wrapRuntimeModule(await importOriginal<typeof RuntimeModule>());
});

failOnRuntimeOutputContractViolations(DELIBERATELY_VIOLATING_TESTS);
