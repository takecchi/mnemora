import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import type { TickOptions } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tick-lease-ms-validation" };

function build() {
  const stores = createFakeRuntimeStores();
  const llm = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories: [{ content: "本文", provenanceKind: "stated" }] }) as T,
  } satisfies LLMProvider;
  const claim = { calls: 0 };
  const outboxStore = Object.create(stores.outboxStore) as typeof stores.outboxStore;
  outboxStore.claimBatch = async (...args) => {
    claim.calls += 1;
    return stores.outboxStore.claimBatch(...args);
  };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores, claim };
}

const tick = (runtime: ReturnType<typeof build>["runtime"], opts: unknown) =>
  runtime.tick(ctx, opts as TickOptions);

describe("runtime.tick: opts / leaseMs の入口検査", () => {
  it.each([
    ["undefined（第2引数ごと省略）", undefined],
    ["null", null],
    ["文字列", "60000"],
    ["数", 60_000],
  ])("opts が object でない（%s）は TypeError。claim しない", async (_label, opts) => {
    const { runtime, claim } = build();
    const err = await tick(runtime, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/Runtime\.tick: opts must be an object/);
    expect(claim.calls).toBe(0);
  });

  it.each([
    ["{}（leaseMs 無し）", {}],
    ["leaseMs: undefined", { leaseMs: undefined }],
    ["文字列", { leaseMs: "60000" }],
    ["null", { leaseMs: null }],
    ["NaN", { leaseMs: Number.NaN }],
    ["Infinity", { leaseMs: Number.POSITIVE_INFINITY }],
    ["-Infinity", { leaseMs: Number.NEGATIVE_INFINITY }],
    ["kinds だけ渡した", { kinds: ["extract"] }],
  ])(
    "leaseMs が有限の数でない（%s）は RangeError。claim せず、ジョブは取れるまま",
    async (_label, opts) => {
      const { runtime, stores, claim } = build();
      await runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });

      const err = await tick(runtime, opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toMatch(
        /Runtime\.tick: opts\.leaseMs must be a finite number/,
      );
      expect(claim.calls).toBe(0);
      expect(stores.outboxStore.listJobs(ctx).map((j) => j.attempts)).toEqual([0]);

      // 落ちた tick が claim していれば、同じ時刻の正しい tick は 0 件になる。
      const after = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
      expect(after.processed + after.failed).toBe(1);
    },
  );

  it.each([
    ["正の整数", 60_000],
    ["小数", 0.5],
    ["0（今までどおり通す）", 0],
    ["負（今までどおり通す）", -1],
  ])("陽性対照: 有限の数（%s）は断らず、claim する", async (_label, leaseMs) => {
    const { runtime, claim } = build();
    await runtime.observe(ctx, { kind: "utterance", text: "発話", extract: "deferred" });
    const result = await runtime.tick(ctx, { kinds: ["extract"], leaseMs });
    expect(claim.calls).toBe(1);
    expect(result.processed + result.failed).toBe(1);
  });
});
