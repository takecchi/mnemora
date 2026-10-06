import { describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * ADR 0630: `observe` の経路で、store が「書いたら読み戻すと `MemorySchema` を通らない」候補を拒んだとき、
 * その候補だけが落ち（`created` の `meta.droppedCandidates` に残る）、observe 全体は落ちず、ほかの候補は書かれる。
 * 全件が壊れていれば、observe は最初の例外のまま投げ、何も書かない。
 * （`RuntimeConfig.extractorVersion` の空文字は、`createRuntime` が組み立ての時点で拒む。）
 * testkit の `InMemoryMemoryStore`（`createMemoriesWithOutboxAndEvents` を持つ。1つのまとまりで書く経路）の側。
 * `@mnemora/postgres` は `observe-new-memory-well-formed.postgres.test.ts`、core の Fake は
 * `observe-new-memory-malformed-candidate-fake.test.ts`。
 *
 * 壊れた候補は、Runtime が作る `NewMemory` では自然には作れない（digest は本文から補われる）ので、store の手前で
 * 1件の `digest` を空文字に書き換える Proxy で作る。
 */

const ctx: Ctx = { tenantId: "in-memory-observe-malformed-candidate" };
const BAD = "壊れる候補";

let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
    }),
};

/** 本文が {@link BAD} の候補だけ、store へ渡す前に `digest` を空文字にする。 */
function corrupting(inner: InMemoryMemoryStore): MemoryStore {
  return new Proxy(inner as MemoryStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "createMemoriesWithOutboxAndEvents") {
        return (
          ...args: Parameters<NonNullable<MemoryStore["createMemoriesWithOutboxAndEvents"]>>
        ) => {
          const [c, news, ...rest] = args;
          const next = news.map((entry) =>
            entry.input.content === BAD
              ? { ...entry, input: { ...entry.input, digest: "" } }
              : entry,
          );
          return (value as NonNullable<MemoryStore["createMemoriesWithOutboxAndEvents"]>).call(
            target,
            c,
            next,
            ...rest,
          );
        };
      }
      return value.bind(target);
    },
  });
}

function makeKit(extractorVersion?: string) {
  const memoryStore = new InMemoryMemoryStore();
  const runtime = createRuntime({
    llmProvider: llm,
    embeddingProvider: {
      space: { provider: "test", model: "malformed", dimensions: 3 },
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    memoryStore: corrupting(memoryStore),
    vectorStore: new InMemoryVectorStore(memoryStore),
    eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
    outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
    tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
    ...(extractorVersion === undefined ? {} : { config: { extractorVersion } }),
  });
  return { runtime, memoryStore };
}

describe("InMemoryMemoryStore: 壊れた候補を含む抽出結果（ADR 0630）", () => {
  it("壊れた候補だけを落として残りを書き、observe は投げない。落とした候補は created の meta に残る", async () => {
    const { runtime, memoryStore } = makeKit();
    candidates = ["一件目の事実", BAD, "三件目の事実"];
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(2);
    expect(
      memoryStore
        .listByTenant(ctx)
        .map((m) => m.content)
        .sort(),
    ).toEqual(["一件目の事実", "三件目の事実"]);
    const created = memoryStore.events.filter((e) => e.kind === "created");
    expect(created).toHaveLength(2);
    for (const event of created) {
      const dropped = (event.meta as { droppedCandidates?: Array<Record<string, unknown>> })
        .droppedCandidates!;
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ index: 1 });
      expect(String(dropped[0]!.message)).toMatch(/digest is malformed/);
    }
  });

  it("全件が壊れていれば、observe は最初の例外のまま投げ、何も書かない", async () => {
    const { runtime, memoryStore } = makeKit();
    candidates = [BAD];
    await expect(runtime.observe(ctx, { kind: "utterance", text: "発話" })).rejects.toThrow(
      /digest is malformed/,
    );
    expect(memoryStore.listByTenant(ctx)).toEqual([]);
    expect(memoryStore.events.filter((e) => e.kind === "created")).toEqual([]);
  });

  it("RuntimeConfig.extractorVersion が空文字なら、createRuntime が組み立ての時点で投げる", () => {
    expect(() => makeKit("")).toThrow(/extractorVersion must not be empty or whitespace-only/);
  });
});
