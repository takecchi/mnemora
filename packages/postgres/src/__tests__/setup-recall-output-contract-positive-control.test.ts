import { describe, expect, it } from "vitest";
import { createRuntime, type Ctx, type TokenCounter } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { takeRuntimeOutputContractProblemsForTesting } from "../../../core/src/__tests__/runtime-output-contract-harness.js";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";

/**
 * `setup-recall-output-contract.ts`（`vi.mock` で `createRuntime` の戻り値を検査に通す配線）の
 * 陽性対照（Issue #1276 / ADR 0397）。
 *
 * ## なぜ要るか
 *
 * 並列 project は `isolate: false` で走る（`vitest.config.mts`）。ファイルの間でモジュールが
 * 共有されるので、`vi.mock` の包みが2つ目以降のファイルでも効き続けるかは、検査の側から
 * 見えない——包みが効かなくなっても、契約を破る呼び出しが無い限り、テストは黙って緑のままである
 * （`DELIBERATELY_VIOLATING_TESTS` は空。わざと破るテストが1本も無いので、検査が
 * 落ちる場面が無い）。この歯は、わざと契約を破る呼び出しをして、**破れが実際に溜まること**を
 * 確かめる。包みが効いていなければ、溜まらず、ここで赤になる。
 *
 * ## 仕組み
 *
 * - 破れの作り方は core の `recall-pipeline.test.ts`（T1）と同じ——`RuntimeDeps.tokenCounter` に
 *   非整数を返す実装を差す（呼び出し側が実際に差せる拡張点）。`usage.estimatedTokens` は
 *   整数の契約なので、`recall()` の戻り値が契約を破る。
 * - 溜まった破れを `takeRuntimeOutputContractProblemsForTesting()` で取り出して、
 *   `afterEach` の検査（`failOnRuntimeOutputContractViolations`）に渡さない——`DELIBERATELY_VIOLATING_TESTS`
 *   へ名前を足す方式だと、破れが溜まったかを確かめる手段が無い（一覧は「溜まっても無視する」だけ）。
 * - 対（契約を守る呼び出しでは何も溜まらない）も同じファイルに置く。「何でも溜める」包みを
 *   陽性の側だけでは見分けられない。
 * - DB は使わない（包みは store に依らない）。並列 project に置く（`SERIAL_TEST_FILES` に入れない）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function buildRuntime(tokenCounter?: TokenCounter) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    tokenCounter,
  });
  return { runtime, stores };
}

async function seedEmbeddedMemory(stores: ReturnType<typeof createFakeRuntimeStores>) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, embeddingStatus: "ready", recordedAt: NOW }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
}

describe("出力の契約の検査（setup-recall-output-contract.ts）の陽性対照", () => {
  it("陽性対照: 契約を破る recall() の戻り値が、検査に溜まる（包みが効いていなければここで赤になる）", async () => {
    // 検査が溜めた破れは、前のテストの afterEach で空になっている。念のため空にしてから始める。
    takeRuntimeOutputContractProblemsForTesting();

    const { runtime, stores } = buildRuntime({
      count: () => ({ tokens: 2.5, counter: "heuristic" }),
    });
    await seedEmbeddedMemory(stores);
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    // 破れの作り方が効いていること（これが偽なら、この歯は何も見ていない）。
    expect(result.usage.estimatedTokens).toBe(2.5);

    const found = takeRuntimeOutputContractProblemsForTesting();
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toMatch(/estimatedTokens/);
  });

  it("対: 契約を守る recall() の戻り値では、何も溜まらない", async () => {
    takeRuntimeOutputContractProblemsForTesting();

    const { runtime, stores } = buildRuntime();
    await seedEmbeddedMemory(stores);
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories.length).toBeGreaterThan(0);

    expect(takeRuntimeOutputContractProblemsForTesting()).toEqual([]);
  });
});
