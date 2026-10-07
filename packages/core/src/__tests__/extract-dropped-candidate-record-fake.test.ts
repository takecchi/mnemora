import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "extract-dropped-candidate-record-fake" };
const hashContent = (content: string) => `h(${content})`;

function llmReturning(contents: readonly string[]): LLMProvider {
  return {
    complete: async () => ({ content: "" }),
    completeStructured: async (_ctx, req) =>
      req.schema.parse({
        memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
      }),
  };
}

function makeKit(
  contents: readonly string[],
  hooks: {
    throwFor?: (content: string) => unknown;
    appendThrows?: unknown;
  },
) {
  const stores = createFakeRuntimeStores();
  const memoryStore = new Proxy(stores.memoryStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "createMemoryWithOutbox") return value.bind(target);
      return (...args: Parameters<MemoryStore["createMemoryWithOutbox"]>) => {
        const thrown = hooks.throwFor?.(args[1].content);
        if (thrown !== undefined) return Promise.reject(thrown);
        return (value as MemoryStore["createMemoryWithOutbox"]).apply(target, args);
      };
    },
  }) as MemoryStore;
  const eventStore = new Proxy(stores.eventStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "append") return value.bind(target);
      return (...args: Parameters<EventStore["append"]>) => {
        if (hooks.appendThrows !== undefined && args[1].kind === "created") {
          return Promise.reject(hooks.appendThrows);
        }
        return (value as EventStore["append"]).apply(target, args);
      };
    },
  }) as EventStore;
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llmReturning(contents),
    embeddingProvider: stores.embeddingProvider,
    hashContent,
  });
  return {
    runtime,
    stores,
    createdMetas: async () =>
      (await stores.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {}),
  };
}

function droppedOf(meta: Record<string, unknown>): Array<Record<string, unknown>> {
  return meta.droppedCandidates as Array<Record<string, unknown>>;
}

describe("core の Fake: 落とした候補の記録（#1063）", () => {
  it("前提: この Fake は createMemoriesWithOutboxAndEvents を持たない（core の経路を通る）", () => {
    expect("createMemoriesWithOutboxAndEvents" in createFakeRuntimeStores().memoryStore).toBe(
      false,
    );
  });

  it("message は最も内側の原因から取り、NUL・孤立サロゲートを置き換えて 500 文字で切る。外側の message（本文を含みうる）は写さない", async () => {
    const inner = Object.assign(
      new Error(`bad\u0000value-${"x".repeat(5)}\uD800-${"y".repeat(700)}`),
      { code: "22021" },
    );
    const outer = new Error("Failed query: insert into memories … params: SECRET-BODY-TEXT", {
      cause: inner,
    });
    const kit = makeKit(["残る1件目", "BAD", "残る2件目"], {
      throwFor: (content) => (content === "BAD" ? outer : undefined),
    });

    const result = await kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });

    expect(result.memoryIds).toHaveLength(2);
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      const dropped = droppedOf(meta);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        index: 1,
        contentHash: hashContent("BAD"),
        code: "22021",
      });
      const message = dropped[0]!.message as string;
      expect(message).not.toContain("\u0000");
      expect(message.startsWith("bad\\u0000value-")).toBe(true);
      expect(message).toContain("�");
      expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(Array.from(message)).toHaveLength(500);
      expect(JSON.stringify(dropped)).not.toContain("SECRET-BODY-TEXT");
      expect(JSON.stringify(dropped)).not.toContain("Failed query");
    }
  });

  it("code は最も内側の原因が名乗った空でない文字列だけ。空文字・数値・無いときは null", async () => {
    const emptyCode = Object.assign(new Error("empty code"), { code: "" });
    const numericCode = Object.assign(new Error("numeric code"), { code: 22021 });
    const noCode = new Error("no code");
    const outerOnlyCode = new Error("outer has the code", {
      cause: Object.assign(new Error("inner has none")),
    });
    Object.assign(outerOnlyCode, { code: "OUTER" });
    const errors: Record<string, Error> = {
      "BAD-empty": emptyCode,
      "BAD-numeric": numericCode,
      "BAD-none": noCode,
      "BAD-outer": outerOnlyCode,
    };
    const kit = makeKit(["残る", ...Object.keys(errors)], {
      throwFor: (content) => errors[content],
    });

    await kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });

    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(1);
    const dropped = droppedOf(metas[0]!);
    expect(dropped.map((d) => [d.index, d.code, d.message])).toEqual([
      [1, null, "empty code"],
      [2, null, "numeric code"],
      [3, null, "no code"],
      [4, null, "inner has none"],
    ]);
  });
});

describe("core の Fake: 全件が保存できないとき・created の追記が失敗したとき（#1063）", () => {
  it("全件が落ちたら、最初の例外をそのまま投げる（最後の例外ではない）", async () => {
    const errors: Record<string, Error> = {
      "BAD-1": new Error("first-error"),
      "BAD-2": new Error("second-error"),
      "BAD-3": new Error("third-error"),
    };
    const kit = makeKit(Object.keys(errors), { throwFor: (content) => errors[content] });

    await expect(kit.runtime.observe(ctx, { kind: "utterance", text: "発話" })).rejects.toBe(
      errors["BAD-1"],
    );
    expect(await kit.createdMetas()).toEqual([]);
  });

  it("書けた後の created の追記が失敗したら、握りつぶさず observe は投げる", async () => {
    const boom = new Error("append boom");
    const kit = makeKit(["1件目", "2件目"], { appendThrows: boom });

    await expect(kit.runtime.observe(ctx, { kind: "utterance", text: "発話" })).rejects.toBe(boom);
  });
});
