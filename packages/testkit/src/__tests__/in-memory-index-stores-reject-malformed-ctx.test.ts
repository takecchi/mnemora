import { describe, expect, it } from "vitest";
import { isMalformedIdentifierError } from "@mnemora/core";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryRelationStore } from "../__fixtures__/in-memory-relation-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

// 同梱の store は、`ctx` を取る全メソッドの入口で `tenantId`・`subjectId` の孤立サロゲート・NUL を断る（`Ctx` の doc）。
// 他の引数は正しい形にしておき、`ctx` だけが理由で断られることを見る。

const TENANT = "in-memory-index-stores-malformed-ctx";
const ctx: Ctx = { tenantId: TENANT };
const SPACE = { provider: "p", model: "m", dimensions: 3 };
const FILTER = { tenantId: TENANT };

const MALFORMED_CTX: ReadonlyArray<readonly [label: string, ctx: Ctx]> = [
  ["tenantId に孤立した上位サロゲート", { tenantId: `${TENANT}\uD800` }],
  ["tenantId に NUL", { tenantId: `${TENANT}\u0000` }],
  ["subjectId に孤立した下位サロゲート", { tenantId: TENANT, subjectId: "s-\uDC00" }],
  ["subjectId に NUL", { tenantId: TENANT, subjectId: "s-\u0000" }],
];

async function setup() {
  const memoryStore = new InMemoryMemoryStore();
  const relationStore = new InMemoryRelationStore(memoryStore, memoryStore.relations);
  const vectorStore = new InMemoryVectorStore(memoryStore);
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  const make = async (n: number): Promise<MemoryId> =>
    (
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          content: "alpha",
          contentHash: `malformed-ctx-${n}`,
        }),
      )
    ).id;
  const a = await make(1);
  const b = await make(2);
  await relationStore.link(ctx, "contradicts", a, b);
  await vectorStore.upsert(ctx, SPACE, a, [1, 0, 0]);
  return { relationStore, vectorStore, lexicalStore, a, b };
}
type Kit = Awaited<ReturnType<typeof setup>>;

const ENTRIES: ReadonlyArray<
  readonly [name: string, call: (k: Kit, bad: Ctx) => Promise<unknown>]
> = [
  ["RelationStore.link", (k, bad) => k.relationStore.link(bad, "contradicts", k.a, k.b)],
  ["RelationStore.unlink", (k, bad) => k.relationStore.unlink(bad, "contradicts", k.a, k.b)],
  ["RelationStore.listRelated", (k, bad) => k.relationStore.listRelated(bad, k.a)],
  ["RelationStore.listRelatedMany", (k, bad) => k.relationStore.listRelatedMany(bad, [k.a])],
  ["VectorStore.upsert", (k, bad) => k.vectorStore.upsert(bad, SPACE, k.a, [0, 1, 0])],
  [
    "VectorStore.search",
    (k, bad) => k.vectorStore.search(bad, SPACE, [1, 0, 0], { limit: 5, filter: FILTER }),
  ],
  [
    "VectorStore.searchMany（queries が空）",
    (k, bad) => k.vectorStore.searchMany(bad, SPACE, [], { limit: 5, filter: FILTER }),
  ],
  ["VectorStore.delete", (k, bad) => k.vectorStore.delete(bad, SPACE, k.a)],
  ["VectorStore.deleteAcrossSpaces", (k, bad) => k.vectorStore.deleteAcrossSpaces(bad, [k.a])],
  ["VectorStore.eraseTenant", (k, bad) => k.vectorStore.eraseTenant(bad, { limit: 10 })],
  ["VectorStore.getVectors", (k, bad) => k.vectorStore.getVectors(bad, SPACE, [k.a])],
  [
    "LexicalStore.search",
    (k, bad) => k.lexicalStore.search(bad, "alpha", { limit: 5, filter: FILTER }),
  ],
];

describe("InMemory の Relation・Vector・Lexical store: ctx の識別子が壊れていれば、どの口も入口で断る", () => {
  describe.each(ENTRIES)("%s", (_, call) => {
    it.each(MALFORMED_CTX)("%s", async (_label, bad) => {
      const kit = await setup();
      const error = await call(kit, bad).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isMalformedIdentifierError(error)).toBe(true);
    });
  });
});
