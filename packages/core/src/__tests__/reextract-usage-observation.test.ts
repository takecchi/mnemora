import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1099: `kind: "usage"` の Observation（`observe({ kind: "memory_usage" })` が作る
 * 使用報告）は、抽出器を通らない（`docs/memory-model.md` §2・§6、`ExtractionOutcome` の
 * `skipped` の doc）。ところが `reextract` は `kind` を見ずに `extractCandidates` を呼び、
 * payload の JSON（`{"recallId":…,"usedMemoryIds":[…]}`）を LLM に送って、それを本文とする
 * `stated` の Memory を作っていた（Fake と Postgres の両方で実測。書き込み側の差分ファズで
 * 見つけた）。
 *
 * 直した後は、存在しない Observation と同じく、LLM も書き込みも試みる前に `Error` を投げる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

/** 抽出の呼び出しを数える LLM。抽出には、プロンプトの本文をそのまま1件の候補にして返す。 */
class CountingLLM implements LLMProvider {
  structuredCalls = 0;
  async complete() {
    return { content: "" };
  }
  async completeStructured<T>(_c: Ctx, req: StructuredRequest<T>): Promise<T> {
    this.structuredCalls += 1;
    const text = req.prompt.messages.find((m) => m.role === "user")?.content ?? "";
    return req.schema.parse({ memories: [{ content: text, provenanceKind: "stated" }] });
  }
}

async function setup() {
  const stores = createFakeRuntimeStores();
  const llm = new CountingLLM();
  const runtime = createRuntime({
    ...stores,
    llmProvider: llm,
    hashContent: (text) => createHash("sha256").update(text).digest("hex"),
  });
  const observed = await runtime.observe(ctx, { kind: "utterance", text: "猫が好き" });
  const recalled = await runtime.recall(ctx, { text: "猫" });
  const usage = await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: recalled.recallId,
    usedMemoryIds: observed.memoryIds,
  });
  return { stores, llm, runtime, usage };
}

describe("reextract: 使用報告の Observation（kind: usage）は抽出しない（Issue #1099）", () => {
  it("usage の Observation を渡すと、LLM も書き込みも試みる前に Error を投げる", async () => {
    const { stores, llm, runtime, usage } = await setup();
    const callsBefore = llm.structuredCalls;
    const memoriesBefore = await stores.memoryStore.listBySourceObservation(
      ctx,
      usage.observationId,
      "v1",
    );

    await expect(runtime.reextract(ctx, usage.observationId)).rejects.toThrow(
      /runtime\.reextract: .*usage/,
    );

    expect(llm.structuredCalls).toBe(callsBefore);
    expect(
      await stores.memoryStore.listBySourceObservation(ctx, usage.observationId, "v1"),
    ).toEqual(memoriesBefore);
    expect(memoriesBefore).toEqual([]);
  });

  it("例外は、存在しない Observation のときと同じ種類（Error）である", async () => {
    const { runtime, usage } = await setup();
    const missing = await runtime.reextract(ctx, "does-not-exist").catch((e: unknown) => e);
    const onUsage = await runtime.reextract(ctx, usage.observationId).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(Error);
    expect(onUsage).toBeInstanceOf(Error);
    expect((onUsage as Error).constructor).toBe((missing as Error).constructor);
  });

  it("回帰確認: 発話の Observation の reextract はこれまでどおり抽出する", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      ...stores,
      llmProvider: new CountingLLM(),
      hashContent: (text) => createHash("sha256").update(text).digest("hex"),
    });
    const observed = await runtime.observe(ctx, { kind: "utterance", text: "犬も好き" });
    const result = await runtime.reextract(ctx, observed.observationId);
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
  });

  // 拒むのは使用報告だけ。発話以外の種類（event・document）の reextract も、今までどおり抽出する。
  it.each([
    ["event", { kind: "event", name: "login" }],
    ["document", { kind: "document", content: "文書の本文" }],
  ] as const)(
    "回帰確認: %s の Observation の reextract もこれまでどおり抽出する",
    async (_label, input) => {
      const stores = createFakeRuntimeStores();
      const runtime = createRuntime({
        ...stores,
        llmProvider: new CountingLLM(),
        hashContent: (text) => createHash("sha256").update(text).digest("hex"),
      });
      const observed = await runtime.observe(ctx, input);
      const result = await runtime.reextract(ctx, observed.observationId);
      expect(result.extraction).toBe("ok");
      expect(result.memoryIds).toHaveLength(1);
    },
  );
});
