import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, RelationStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryRelationStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "relation-store-parity" };

interface Kit {
  memoryStore: MemoryStore;
  relationStore: RelationStore;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return { memoryStore: new PostgresMemoryStore(db), relationStore: new PostgresRelationStore(db) };
}

function inMemoryKit(): Kit {
  const memoryStore = new InMemoryMemoryStore();
  return { memoryStore, relationStore: new InMemoryRelationStore(memoryStore) };
}

async function memory(kit: Kit, n: string): Promise<MemoryId> {
  const m = await kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `rel-parity-${n}`, content: n }),
  );
  return m.id;
}

afterAll(async () => {
  await closeTestClient();
});

const kits: Array<[string, () => Promise<Kit>]> = [
  ["postgres", postgresKit],
  ["testkit の fixture", async () => inMemoryKit()],
];

describe.each(kits)("RelationStore の入力と冪等（ADR 0488）: %s", (_name, build) => {
  it("link は冪等。自分自身への link も書ける。unlink は無い行も2回目も例外にしない", async () => {
    const kit = await build();
    const a = await memory(kit, "a");
    const b = await memory(kit, "b");
    const rs = kit.relationStore;
    await rs.link(ctx, "contradicts", a, b);
    await rs.link(ctx, "contradicts", a, b);
    await rs.link(ctx, "contradicts", a, a);
    expect((await rs.listRelated(ctx, a)).map((r) => r.memoryId).sort()).toEqual([a, b].sort());
    // 向きは片方だけ（b から a は張っていない）。
    expect(await rs.listRelated(ctx, b)).toEqual([]);
    await rs.unlink(ctx, "contradicts", a, b);
    await rs.unlink(ctx, "contradicts", a, b);
    await rs.unlink(ctx, "contradicts", b, a);
    expect((await rs.listRelated(ctx, a)).map((r) => r.memoryId)).toEqual([a]);
  });

  it.each(["", null, "Contradicts", "bogus", "__proto__", "toString", 0])(
    "link は範囲外の kind (%j) を unknown relation kind で断り、unlink は何もしない",
    async (kind) => {
      const kit = await build();
      const a = await memory(kit, "a");
      const b = await memory(kit, "b");
      const rs = kit.relationStore;
      await expect(rs.link(ctx, kind as never, a, b)).rejects.toThrow(/unknown relation kind/);
      await rs.unlink(ctx, kind as never, a, b);
      expect(await rs.listRelated(ctx, a)).toEqual([]);
    },
  );

  it("壊れた id: listRelated は空、listRelatedMany はその位置だけ空、unlink は何もしない、link は memory not found", async () => {
    const kit = await build();
    const a = await memory(kit, "a");
    const b = await memory(kit, "b");
    const rs = kit.relationStore;
    await rs.link(ctx, "contradicts", a, b);
    expect(await rs.listRelated(ctx, "nope" as MemoryId)).toEqual([]);
    expect(await rs.listRelated(ctx, `${a}\u0000` as MemoryId)).toEqual([]);
    const many = await rs.listRelatedMany!(ctx, ["nope" as MemoryId, a, a]);
    expect(many.map((l) => l.length)).toEqual([0, 1, 1]);
    expect(many[1]).not.toBe(many[2]);
    await rs.unlink(ctx, "contradicts", `${a}\u0000` as MemoryId, b);
    await expect(rs.link(ctx, "contradicts", `${a}\u0000` as MemoryId, b)).rejects.toThrow(
      /memory not found for tenant/,
    );
  });

  it("記憶を forget しても関係は残り、listRelated も link も、forget した記憶を弾かない（今の振る舞い）", async () => {
    const kit = await build();
    const a = await memory(kit, "a");
    const b = await memory(kit, "b");
    const rs = kit.relationStore;
    await rs.link(ctx, "contradicts", a, b);
    await kit.memoryStore.updateStatus(ctx, a, "forgotten");
    expect((await rs.listRelated(ctx, a)).map((r) => r.memoryId)).toEqual([b]);
    await rs.link(ctx, "contradicts", b, a);
    expect((await rs.listRelated(ctx, b)).map((r) => r.memoryId)).toEqual([a]);
  });
});

describe.each(kits)(
  "listRelated の kind が undefined 以外の偽の値（今の割れ。ADR 0488 の材料）: %s",
  (name, build) => {
    it.each(["", null, 0])("kind=%j", async (kind) => {
      const kit = await build();
      const a = await memory(kit, "a");
      const b = await memory(kit, "b");
      await kit.relationStore.link(ctx, "contradicts", a, b);
      const expected = name === "postgres" ? 1 : 0;
      expect(await kit.relationStore.listRelated(ctx, a, kind as never)).toHaveLength(expected);
      expect((await kit.relationStore.listRelatedMany!(ctx, [a], kind as never))[0]).toHaveLength(
        expected,
      );
    });
  },
);
