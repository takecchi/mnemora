import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "in-memory-lexical-valid-at-boundary";
const ctx: Ctx = { tenantId: TENANT };
const T = new Date("2026-03-01T00:00:00.000Z");

async function setup(validity: { validFrom?: Date | null; validUntil?: Date | null }) {
  const memoryStore = new InMemoryMemoryStore();
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, content: "alpha", ...validity }),
  );
  const search = async (validAt: Date) =>
    (
      await lexicalStore.search(ctx, "alpha", {
        limit: 5,
        filter: { tenantId: TENANT, validAt },
      })
    ).map((h) => h.memoryId);
  return { memory, search };
}

describe("InMemoryLexicalStore.search: filter.validAt の validFrom は閉じた左端（validFrom <= validAt なら通る）", () => {
  it("validAt が validFrom とちょうど同じなら返り、1ms 前なら返らない", async () => {
    const { memory, search } = await setup({ validFrom: T, validUntil: null });
    expect(await search(T)).toEqual([memory.id]);
    expect(await search(new Date(T.getTime() - 1))).toEqual([]);
  });
});
