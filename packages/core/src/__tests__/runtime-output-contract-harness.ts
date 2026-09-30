import { afterEach, expect } from "vitest";
import type * as RuntimeModule from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { checkRecallResultContract } from "./runtime-fakes.js";
import {
  checkApplyCorrectionContract,
  checkConsolidateContract,
  checkFindCorrectionCandidatesContract,
  checkForgetContract,
  checkGetRecallContract,
  checkMarkContestedContract,
  checkObserveContract,
  checkPurgeContract,
  checkReextractContract,
  checkReflectContract,
  checkResolveContestedContract,
  checkResolveOrphanedContestedContract,
  checkRestoreArchivedContract,
  checkRestoreSupersededContract,
  checkSweepArchiveContract,
  checkTickContract,
} from "./runtime-return-contract.js";

/**
 * `Runtime` の戻り値の契約の検査を、テストの一式全体に配線するための部品
 * （TSDoc の7巡目 B1・B2 で始まり、8巡目で `recall()` 以外の16メソッドへ広げた）。
 * core・testkit・postgres の setup ファイルが共有する。
 *
 * `recall()` は `checkRecallResultContract`（`./runtime-fakes.ts`）、それ以外の16メソッドは
 * `checkXxxContract`（`./runtime-return-contract.ts`）で検査する——`reembed` だけは対象外
 * （`RequeueEmbedJobsResult` の約束はまだ TSDoc から抽出していない。理由は
 * `runtime-return-contract.ts` 冒頭のコメント参照）。
 *
 * 使い方（setup ファイルで）:
 * 1. `vi.mock(<core の src/runtime.ts へのパス>, async (importOriginal) => wrapRuntimeModule(await importOriginal()))`
 *    で、`createRuntime` が返す各メソッドを包む。`@mnemora/core` の入口も core の `src/runtime.ts` を
 *    再 export しているので、入口から import しても、相対パスで import しても、同じく包まれる。
 * 2. `failOnRuntimeOutputContractViolations(除外の一覧)` で、破れていたらそのテストの `afterEach` で赤にする。
 */

const problems: string[] = [];

/** `createRuntime` が返す各メソッドを包み、戻り値を検査して破れた点を溜める。 */
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

      const observe = runtime.observe.bind(runtime);
      runtime.observe = async (...observeArgs) => {
        const result = await observe(...observeArgs);
        problems.push(...checkObserveContract(observeArgs, result));
        return result;
      };

      const tick = runtime.tick.bind(runtime);
      runtime.tick = async (...tickArgs) => {
        const result = await tick(...tickArgs);
        problems.push(...checkTickContract(result));
        return result;
      };

      const getRecall = runtime.getRecall.bind(runtime);
      runtime.getRecall = async (...getRecallArgs) => {
        const result = await getRecall(...getRecallArgs);
        problems.push(...checkGetRecallContract(getRecallArgs, result));
        return result;
      };

      const findCorrectionCandidates = runtime.findCorrectionCandidates.bind(runtime);
      runtime.findCorrectionCandidates = async (...findArgs) => {
        const result = await findCorrectionCandidates(...findArgs);
        problems.push(...checkFindCorrectionCandidatesContract(findArgs, result));
        return result;
      };

      const reextract = runtime.reextract.bind(runtime);
      runtime.reextract = async (...reextractArgs) => {
        const result = await reextract(...reextractArgs);
        problems.push(...checkReextractContract(reextractArgs, result));
        return result;
      };

      const sweepArchive = runtime.sweepArchive.bind(runtime);
      runtime.sweepArchive = async (...sweepArgs) => {
        const result = await sweepArchive(...sweepArgs);
        problems.push(...checkSweepArchiveContract(result));
        return result;
      };

      const restoreArchived = runtime.restoreArchived.bind(runtime);
      runtime.restoreArchived = async (...restoreArgs) => {
        const result = await restoreArchived(...restoreArgs);
        problems.push(...checkRestoreArchivedContract(restoreArgs, result));
        return result;
      };

      const restoreSuperseded = runtime.restoreSuperseded.bind(runtime);
      runtime.restoreSuperseded = async (...restoreArgs) => {
        const result = await restoreSuperseded(...restoreArgs);
        problems.push(...checkRestoreSupersededContract(restoreArgs, result));
        return result;
      };

      const forget = runtime.forget.bind(runtime);
      runtime.forget = async (...forgetArgs) => {
        const result = await forget(...forgetArgs);
        problems.push(...checkForgetContract(forgetArgs, result));
        return result;
      };

      const purge = runtime.purge.bind(runtime);
      runtime.purge = async (...purgeArgs) => {
        const result = await purge(...purgeArgs);
        problems.push(...checkPurgeContract(purgeArgs, result));
        return result;
      };

      const markContested = runtime.markContested.bind(runtime);
      runtime.markContested = async (...markArgs) => {
        const result = await markContested(...markArgs);
        problems.push(...checkMarkContestedContract(markArgs, result));
        return result;
      };

      const resolveContested = runtime.resolveContested.bind(runtime);
      runtime.resolveContested = async (...resolveArgs) => {
        const result = await resolveContested(...resolveArgs);
        problems.push(...checkResolveContestedContract(resolveArgs, result));
        return result;
      };

      // 任意メソッド（`Runtime.resolveOrphanedContested` の doc コメント参照）。
      // `createRuntime` は必ず実装するが、型がそれを保証しないので在るかを確かめてから包む。
      if (runtime.resolveOrphanedContested) {
        const resolveOrphanedContested = runtime.resolveOrphanedContested.bind(runtime);
        runtime.resolveOrphanedContested = async (...resolveArgs) => {
          const result = await resolveOrphanedContested(...resolveArgs);
          problems.push(...checkResolveOrphanedContestedContract(result));
          return result;
        };
      }

      const applyCorrection = runtime.applyCorrection.bind(runtime);
      runtime.applyCorrection = async (...applyArgs) => {
        const result = await applyCorrection(...applyArgs);
        problems.push(...checkApplyCorrectionContract(applyArgs, result));
        return result;
      };

      const consolidate = runtime.consolidate.bind(runtime);
      runtime.consolidate = async (...consolidateArgs) => {
        const result = await consolidate(...consolidateArgs);
        problems.push(...checkConsolidateContract(consolidateArgs, result));
        return result;
      };

      const reflect = runtime.reflect.bind(runtime);
      runtime.reflect = async (...reflectArgs) => {
        const result = await reflect(...reflectArgs);
        problems.push(...checkReflectContract(reflectArgs, result));
        return result;
      };

      return runtime;
    },
  };
}

/**
 * 溜まった破れを取り出して空にする（**陽性対照の専用**。Issue #1276 / ADR 0397）。
 *
 * 検査が本当に配線されているか（`vi.mock` の包みが効いているか）を、わざと契約を破る呼び出しで
 * 確かめるテストだけが呼ぶ。取り出した破れは `afterEach` から消えるので、そのテストは
 * `DELIBERATELY_VIOLATING_TESTS` に名前を足さなくても赤にならない——代わりに、そのテスト自身が
 * 「破れが1件以上溜まっていた」ことを `expect` する（配線が壊れて何も溜まらなければ、そこで赤になる）。
 */
export function takeRuntimeOutputContractProblemsForTesting(): string[] {
  return problems.splice(0);
}

/**
 * 溜まった破れを、そのテストの `afterEach` で赤にする。
 *
 * ⛔ **`deliberatelyViolatingTests` には、わざと契約を破らせるテストだけを、名前（`it` の名前の末尾一致）で置く。**
 *
 * 呼ばれるのは、包んだメソッドが**例外を投げずに戻った**ときだけである——投げたら、その呼び出しの
 * 戻り値は無いので検査しようがなく、そのまま呼び出し側（テストの `await`/`try`）へ届く。
 */
export function failOnRuntimeOutputContractViolations(
  deliberatelyViolatingTests: readonly string[],
): void {
  afterEach(() => {
    const found = problems.splice(0);
    const name = expect.getState().currentTestName ?? "";
    if (found.length === 0 || deliberatelyViolatingTests.some((t) => name.endsWith(t))) return;
    throw new Error(
      `Runtime の戻り値が出力の契約を破った（${found.length} 件）:\n${[...new Set(found)].join("\n")}`,
    );
  });
}
