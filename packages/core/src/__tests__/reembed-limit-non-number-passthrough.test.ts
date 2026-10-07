import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-reembed-limit-passthrough" };

function setup() {
  const stores = createFakeRuntimeStores();
  const received: unknown[] = [];
  stores.memoryStore.requeueEmbedJobs = async (_ctx, opts) => {
    received.push((opts as { limit?: unknown }).limit);
    return { requeued: 0, memoryIds: [] };
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
  return { runtime, received };
}

describe("Runtime.reembed: 数でない limit は断らず、そのまま store に渡す", () => {
  const passed: Array<[string, unknown]> = [
    ["null（無制限）", null],
    ["数字の文字列", "3"],
    ["bigint", 3n],
  ];

  for (const [label, limit] of passed) {
    it(`${label} は RangeError にならず、store が同じ値を受け取る`, async () => {
      const { runtime, received } = setup();
      const opts = { statuses: ["failed"], limit } as unknown as Parameters<
        typeof runtime.reembed
      >[1];

      await expect(runtime.reembed(ctx, opts)).resolves.toEqual({ requeued: 0, memoryIds: [] });

      expect(received).toEqual([limit]);
    });
  }
});
