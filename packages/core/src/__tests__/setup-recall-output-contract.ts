import { vi } from "vitest";
import type * as RuntimeModule from "../runtime.js";
import { failOnRuntimeOutputContractViolations } from "./runtime-output-contract-harness.js";

/**
 * core のすべてのテストで、`createRuntime` が返す `Runtime` の各メソッドの戻り値を検査に通す
 * （`recall()` は `checkRecallResultContract`〔`./runtime-fakes.ts`〕、それ以外の16メソッドは
 * `./runtime-return-contract.ts` の `checkXxxContract`。TSDoc の7巡目 B1・B2、8巡目で拡張）。
 * 配線の部品は `./runtime-output-contract-harness.ts`（testkit・postgres の setup ファイルと共有）。
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
  // ADR 0483: 約束を破る値を返す TokenCounter を差し、recall() の今の振る舞い（予算を外す・全件落とす・usage に素通し）を縛る歯。
  "NaN を返す counter は、予算を黙って外して全件を返し、usage の検証で知らされる",
  "負の数 を返す counter は、予算を黙って外して全件を返し、usage の検証で知らされる",
  "Infinity を返す counter は、1件目から収まらず全件を落とす",
  "counter の欄が無い: 値はそのまま usage.counter に出て、検証で知らされる（正しい値に直さない）",
  "counter が範囲外の文字列: 値はそのまま usage.counter に出て、検証で知らされる（正しい値に直さない）",
];

vi.mock("../runtime.js", async (importOriginal) => {
  const { wrapRuntimeModule } = await import("./runtime-output-contract-harness.js");
  return wrapRuntimeModule(await importOriginal<typeof RuntimeModule>());
});

failOnRuntimeOutputContractViolations(DELIBERATELY_VIOLATING_TESTS);
