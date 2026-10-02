import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { runRecall } from "../recall-runtime.js";
import type { Ctx } from "../ctx.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0496（ADR 0472 材料1）: attributes のキー `__proto__` は、文字種の規則を通っても zod の record がキーの検査より前に読み飛ばし、
 * 黙って落とした（`recall` の絞り込みが `{}` になって外れる・`observe` の属性が消える）。今は `Runtime.observe`・`Runtime.recall` の入口が、
 * zod の前に `ZodError`（既存のキー検査と同じ `invalid_key`）で断る。`constructor`・`prototype` などは落ちないので断らない。
 * `JSON.parse` は `__proto__` を自前のキーとして作る（オブジェクトリテラルの `{ __proto__: … }` は prototype の設定で、キーにならない）。
 */

const ctx: Ctx = { tenantId: "tenant-attributes-proto" };
const NOW = new Date("2099-01-01T00:00:00.000Z");

function build() {
  const stores = createFakeRuntimeStores();
  const deps = {
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async (_c: Ctx, req: { schema: { parse(x: unknown): unknown } }) =>
        req.schema.parse({ memories: [{ content: "抽出結果", provenanceKind: "stated" }] }),
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  };
  const runtime = createRuntime(deps as never);
  return { runtime, stores };
}

const parse = (json: string) => JSON.parse(json) as Record<string, string>;
const PROTO = '{"__proto__":"x"}';
const PROTO_AND_OTHER = '{"visibility":"internal","__proto__":"x"}';

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => "resolved",
    (e: unknown) => e,
  );
}

describe("recall の attributes に __proto__", () => {
  it.each([PROTO, PROTO_AND_OTHER])(
    "%s は ZodError（invalid_key、path は attributes.__proto__）で断る",
    async (json) => {
      const { runtime } = build();
      const err = await rejection(runtime.recall(ctx, { text: "q", attributes: parse(json) }));
      expect(err).toBeInstanceOf(ZodError);
      const issues = (err as ZodError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        code: "invalid_key",
        origin: "record",
        path: ["attributes", "__proto__"],
      });
      expect(JSON.stringify(issues)).not.toContain('"x"');
    },
  );

  it("独立関数 runRecall も同じ", async () => {
    const stores = createFakeRuntimeStores();
    const err = await rejection(
      runRecall(ctx, { text: "q", attributes: parse(PROTO) }, {
        memoryStore: stores.memoryStore,
        vectorStore: stores.vectorStore,
        embeddingProvider: stores.embeddingProvider,
        tenantSettingsStore: stores.tenantSettingsStore,
        clock: { now: () => NOW },
        tokenCounter: { count: (t: string) => t.length },
      } as never),
    );
    expect(err).toBeInstanceOf(ZodError);
  });
});

describe("observe の attributes に __proto__", () => {
  it.each(["utterance", "event", "data"] as const)(
    "%s: ZodError で断り、何も書かない",
    async (kind) => {
      const { runtime, stores } = build();
      const input =
        kind === "utterance"
          ? { kind, text: "x" }
          : kind === "event"
            ? { kind, description: "x" }
            : { kind, payload: { a: 1 } };
      const err = await rejection(
        runtime.observe(ctx, { ...input, attributes: parse(PROTO) } as never),
      );
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues[0]).toMatchObject({
        code: "invalid_key",
        path: ["attributes", "__proto__"],
      });
      expect(stores.eventStore.events).toHaveLength(0);
    },
  );
});

describe("陽性対照（やりすぎを弾く）: __proto__ 以外のキーは今までどおり通る", () => {
  it.each([
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "__proto",
    "proto__",
    "__PROTO__",
  ])("%s は observe で属性として残り、recall の絞り込みにも使える", async (key) => {
    const { runtime, stores } = build();
    const attrs = parse(JSON.stringify({ [key]: "x" }));
    const result = await runtime.observe(ctx, { kind: "utterance", text: "x", attributes: attrs });
    const memories = await stores.memoryStore.listBySourceObservation(
      ctx,
      result.observationId,
      "v1",
    );
    expect(Object.keys(memories[0]?.attributes ?? {})).toEqual([key]);
    await expect(runtime.recall(ctx, { text: "q", attributes: attrs })).resolves.toBeDefined();
  });

  it("attributes の省略・空の object・普通のキーは通る", async () => {
    const { runtime } = build();
    await expect(runtime.recall(ctx, { text: "q" })).resolves.toBeDefined();
    await expect(runtime.recall(ctx, { text: "q", attributes: {} })).resolves.toBeDefined();
    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "x",
        attributes: { visibility: "internal" },
      }),
    ).resolves.toBeDefined();
  });
});
