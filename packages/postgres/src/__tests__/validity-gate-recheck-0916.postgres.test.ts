import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LexicalStore, MemoryStore, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryLexicalStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "validity-gate-recheck" };
const AT = new Date("2026-06-01T00:00:00.000Z");
const ms = (n: number) => new Date(AT.getTime() + n);
const TEXT = "obsidian shards glimmer";

interface Impl {
  name: string;
  create: () => Promise<{ memory: MemoryStore; lexical: LexicalStore }>;
}

const impls: Impl[] = [
  {
    name: "InMemory",
    create: async () => {
      const memory = new InMemoryMemoryStore();
      return { memory, lexical: new InMemoryLexicalStore(memory) };
    },
  },
  {
    name: "Postgres",
    create: async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return { memory: new PostgresMemoryStore(db), lexical: new PostgresLexicalStore(db) };
    },
  },
];

function memoryInput(overrides: Partial<NewMemory>): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: TEXT,
    contentHash: `h-${randomUUID()}`,
    ...overrides,
  });
}

describe.each(impls)("有効期間のゲート（$name）", (impl) => {
  afterAll(async () => {
    if (impl.name === "Postgres") await closeTestClient();
  });

  it("語彙チャンネル: validFrom がちょうど validAt の記憶は返り、1ms 後の記憶は返らない", async () => {
    const { memory, lexical } = await impl.create();
    const onBoundary = await memory.createMemory(ctx, memoryInput({ validFrom: AT }));
    const notYet = await memory.createMemory(ctx, memoryInput({ validFrom: ms(1) }));

    const hits = await lexical.search(ctx, "obsidian shards", {
      limit: 10,
      filter: { tenantId: ctx.tenantId, validAt: AT },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(onBoundary.id);
    expect(ids).not.toContain(notYet.id);
  });

  it("aggregateScope: 期限切れ・未発効の件数は、いま有効な status の記憶だけを数える", async () => {
    const { memory } = await impl.create();
    await memory.createMemory(ctx, memoryInput({ validUntil: ms(-1) }));
    await memory.createMemory(ctx, memoryInput({ validUntil: ms(0) }));
    await memory.createMemory(ctx, memoryInput({ validFrom: ms(1) }));
    await memory.createMemory(ctx, memoryInput({}));
    await memory.createMemory(ctx, memoryInput({ status: "archived", validUntil: ms(-1) }));
    await memory.createMemory(ctx, memoryInput({ status: "archived", validFrom: ms(1) }));
    await memory.createMemory(ctx, memoryInput({ status: "forgotten", validFrom: ms(1) }));

    const aggregate = await memory.aggregateScope(ctx, { validAt: AT });

    expect(aggregate.filteredExpired.count).toBe(2);
    expect(aggregate.filteredNotYetValid.count).toBe(1);
    expect(aggregate.totalInScope).toBe(1);
  });

  it("aggregateScope: 逆転した区間の記憶は、期限切れと未発効の両方に1件ずつ数える", async () => {
    const { memory } = await impl.create();
    await memory.createMemory(ctx, memoryInput({ validFrom: ms(1000), validUntil: ms(-1000) }));

    const aggregate = await memory.aggregateScope(ctx, { validAt: AT });

    expect(aggregate.filteredExpired.count).toBe(1);
    expect(aggregate.filteredNotYetValid.count).toBe(1);
    expect(aggregate.totalInScope).toBe(0);
  });
});
