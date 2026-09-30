import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0433 決定4: `Runtime.reembed` は入口で `limit` を検査する。
 *
 * 直す前は、`limit` を省くと Postgres の `LIMIT ${opts.limit}` が `syntax error at or near "FOR"` に
 * なるなど、store の側の分かりにくい例外だった。ここでは、Runtime が store を呼ぶ前に
 * `RangeError` を投げることを縛る（`findCorrectionCandidates` の `limit` と同じ型）。
 *
 * 断るのは、これまでも例外になっていた値（省略・非整数・負・`NaN`・`Infinity`）だけである。
 * これまで成功していた `0` と正の整数は、これまでどおり通る。
 */

const ctx: Ctx = { tenantId: "tenant-reembed-limit" };

function setup() {
  const stores = createFakeRuntimeStores();
  let calls = 0;
  const original = stores.memoryStore.requeueEmbedJobs.bind(stores.memoryStore);
  stores.memoryStore.requeueEmbedJobs = async (...args) => {
    calls += 1;
    return original(...args);
  };
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
  });
  return { runtime, calls: () => calls };
}

describe("Runtime.reembed: limit の検査（ADR 0433 決定4）", () => {
  const rejected: Array<[string, unknown]> = [
    ["省略（undefined）", undefined],
    ["負の整数", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ];

  for (const [label, limit] of rejected) {
    it(`${label} は、store を呼ぶ前に RangeError になる`, async () => {
      const { runtime, calls } = setup();
      const opts = { statuses: ["failed"], limit } as unknown as Parameters<
        typeof runtime.reembed
      >[1];
      await expect(runtime.reembed(ctx, opts)).rejects.toBeInstanceOf(RangeError);
      await expect(runtime.reembed(ctx, opts)).rejects.toThrow(/Runtime\.reembed: limit/);
      expect(calls()).toBe(0);
    });
  }

  it("limit を欠いたオブジェクトも RangeError（TypeError にならない）", async () => {
    const { runtime } = setup();
    const noLimit = { statuses: ["failed"] } as unknown as Parameters<typeof runtime.reembed>[1];
    await expect(runtime.reembed(ctx, noLimit)).rejects.toBeInstanceOf(RangeError);
  });

  it("これまで成功していた値は、これまでどおり通る: 0・1・大きな整数", async () => {
    const { runtime, calls } = setup();
    for (const limit of [0, 1, 10, Number.MAX_SAFE_INTEGER]) {
      await expect(runtime.reembed(ctx, { statuses: ["failed"], limit })).resolves.toEqual({
        requeued: 0,
        memoryIds: [],
      });
    }
    expect(calls()).toBe(4);
  });
});
