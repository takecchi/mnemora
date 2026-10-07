import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresEventStore } from "../event-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

interface Kit {
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return { memoryStore, eventStore: new InMemoryEventStore(memoryStore, memoryStore.events) };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return { memoryStore: new PostgresMemoryStore(db), eventStore: new PostgresEventStore(db) };
    },
  ],
];

const ctx: Ctx = { tenantId: "memories-enum-check" };

afterAll(async () => {
  await closeTestClient();
});

function event(memoryId: string, kind: NewMemoryEvent["kind"]): NewMemoryEvent {
  return { tenantId: ctx.tenantId, memoryId, kind, actor: { type: "system" }, meta: {} };
}

/** 型を外した呼び出しを模す（列挙に無い値）。 */
const BOGUS = "bogus" as never;

describe.each(KITS)("memories の列挙の列の検査（%s）", (_name, build) => {
  const createCases: Array<[string, Partial<NewMemory>]> = [
    ["status", { status: BOGUS }],
    ["digestSource", { digestSource: BOGUS }],
    ["embeddingStatus", { embeddingStatus: BOGUS }],
    ["provenance.kind", { provenance: { kind: BOGUS } }],
  ];
  for (const [field, override] of createCases) {
    // 1行の INSERT なので、Postgres で何も書かないのは自明。fixture 側は DB 無しの歯が件数で縛る。
    it(`createMemory は列挙に無い ${field} を拒む`, async () => {
      const { memoryStore } = await build();
      await expect(
        memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `enum-${field}`,
            ...override,
          }),
        ),
      ).rejects.toThrow();
    });
  }

  it("updateStatus・updateStatusWithEvent は列挙に無い status を拒み、状態もイベントも変えない", async () => {
    const { memoryStore, eventStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-update" }),
    );

    await expect(memoryStore.updateStatus(ctx, m.id, BOGUS)).rejects.toThrow();
    await expect(
      memoryStore.updateStatusWithEvent(ctx, m.id, BOGUS, {}, event(m.id, "updated")),
    ).rejects.toThrow();

    expect((await memoryStore.get(ctx, m.id))?.status).toBe("active");
    expect(await eventStore.list(ctx, { memoryId: m.id })).toHaveLength(0);
  });

  it("setEmbeddingStatus は列挙に無い値を拒み、状態を変えない", async () => {
    const { memoryStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-embedding" }),
    );

    await expect(memoryStore.setEmbeddingStatus(ctx, m.id, BOGUS)).rejects.toThrow();

    expect((await memoryStore.get(ctx, m.id))?.embeddingStatus).toBe(m.embeddingStatus);
  });

  it("resolveContestedPair は列挙に無い status を拒み、2件とも contested のまま残す", async () => {
    const { memoryStore, eventStore } = await build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-pair-a" }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-pair-b" }),
    );
    await memoryStore.markContestedPair!(
      ctx,
      { id: a.id, event: event(a.id, "updated") },
      { id: b.id, event: event(b.id, "updated") },
    );
    const eventsBefore = (await eventStore.list(ctx, {})).length;

    await expect(
      memoryStore.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: event(a.id, "updated") },
        { id: b.id, status: BOGUS, event: event(b.id, "updated") },
      ),
    ).rejects.toThrow();

    expect((await memoryStore.get(ctx, a.id))?.status).toBe("contested");
    expect((await memoryStore.get(ctx, b.id))?.status).toBe("contested");
    expect(await eventStore.list(ctx, {})).toHaveLength(eventsBefore);
  });

  it("列挙の値なら、同じ口は通る（陽性対照）", async () => {
    const { memoryStore } = await build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-ok" }),
    );
    await memoryStore.setEmbeddingStatus(ctx, m.id, "skipped");
    expect((await memoryStore.updateStatus(ctx, m.id, "archived")).status).toBe("archived");
  });
});
