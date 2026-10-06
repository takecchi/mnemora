import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0630: `observe` の経路で、store が「書いたら読み戻すと `MemorySchema` を通らない」候補を拒んだとき、
 * その候補だけが落ち（`created` の `meta.droppedCandidates` に残る）、observe 全体は落ちず、ほかの候補は書かれる。
 * 全件が壊れていれば、今までの「保存できない候補」と同じく、最初の例外のまま observe が投げ、何も書かない。
 * core の Fake の側（旧経路: `createMemoriesWithOutboxAndEvents?` を持たない store は候補ごとに
 * `createMemoryWithOutbox` を呼ぶ）。`@mnemora/postgres` は `observe-new-memory-well-formed.postgres.test.ts`、
 * testkit の fixture は `in-memory-observe-new-memory-malformed-candidate.test.ts`。
 *
 * 壊れた候補は、Runtime が作る `NewMemory` では自然には作れない（digest は本文から補われる）ので、store の手前で
 * 1件の `digest` を空文字に書き換える Proxy で作る。
 */

const ctx: Ctx = { tenantId: "observe-malformed-candidate-fake" };
const BAD = "壊れる候補";

/** extract の LLM が返す候補の本文。 */
let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
    }),
};

/** 本文が {@link BAD} の候補だけ、store へ渡す前に `digest` を空文字にする。 */
function corrupting(inner: MemoryStore): MemoryStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "createMemoryWithOutbox") {
        return (...args: Parameters<MemoryStore["createMemoryWithOutbox"]>) => {
          const [c, input, ...rest] = args;
          const next = input.content === BAD ? { ...input, digest: "" } : input;
          return (value as MemoryStore["createMemoryWithOutbox"]).call(target, c, next, ...rest);
        };
      }
      return value.bind(target);
    },
  });
}

function makeKit(extractorVersion?: string) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: corrupting(stores.memoryStore),
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    outboxStore: stores.outboxStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `h(${content})`,
    ...(extractorVersion === undefined ? {} : { config: { extractorVersion } }),
  });
  return { runtime, stores };
}

describe("core の Fake: 壊れた候補を含む抽出結果（ADR 0630）", () => {
  it("壊れた候補だけを落として残りを書き、observe は投げない。落とした候補は created の meta に残る", async () => {
    const { runtime, stores } = makeKit();
    candidates = ["一件目の事実", BAD, "三件目の事実"];
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(2);
    const written = await stores.memoryStore.listBySourceObservationAllVersions(
      ctx,
      result.observationId,
    );
    expect(written.map((m) => m.content).sort()).toEqual(["一件目の事実", "三件目の事実"]);
    const metas = (await stores.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {});
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      const dropped = meta.droppedCandidates as Array<Record<string, unknown>>;
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ index: 1 });
      expect(String(dropped[0]!.message)).toMatch(/digest is malformed/);
    }
  });

  it("全件が壊れていれば、observe は最初の例外のまま投げ、何も書かない", async () => {
    const { runtime, stores } = makeKit();
    candidates = [BAD];
    await expect(runtime.observe(ctx, { kind: "utterance", text: "発話" })).rejects.toThrow(
      /digest is malformed/,
    );
    expect(await stores.eventStore.list(ctx, { kind: "created" })).toEqual([]);
  });

  it("RuntimeConfig.extractorVersion が空文字なら、createRuntime が組み立ての時点で投げる", () => {
    expect(() => makeKit("")).toThrow(/extractorVersion must not be empty or whitespace-only/);
  });
});
