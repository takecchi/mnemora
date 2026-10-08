import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, RelationKind } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryRelationStore } from "../__fixtures__/in-memory-relation-store.js";

const TENANT = "in-memory-relation-kind-check";
const ctx: Ctx = { tenantId: TENANT };
// uuid の形をしているが、どの記憶も指さない id。
const MISSING = "00000000-0000-4000-8000-000000000000" as MemoryId;

async function setup() {
  const memoryStore = new InMemoryMemoryStore();
  const relationStore = new InMemoryRelationStore(memoryStore, memoryStore.relations);
  let n = 0;
  const make = async (): Promise<MemoryId> => {
    n += 1;
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash: `relation-kind-check-${n}` }),
    );
    return m.id;
  };
  return { relationStore, make };
}

describe("InMemoryRelationStore.link: 列挙の外の kind", () => {
  it("両端が実在しなくても、kind の検査が先に効く（unknown relation kind で断る）", async () => {
    const { relationStore } = await setup();
    await expect(relationStore.link(ctx, "nope" as RelationKind, MISSING, MISSING)).rejects.toThrow(
      /unknown relation kind: nope/,
    );
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "Object の prototype に在る名前（%s）も列挙の外として断り、行は書かない",
    async (kind) => {
      const { relationStore, make } = await setup();
      const a = await make();
      const b = await make();
      await expect(relationStore.link(ctx, kind as RelationKind, a, b)).rejects.toThrow(
        /unknown relation kind/,
      );
      expect(await relationStore.listRelated(ctx, a)).toEqual([]);
    },
  );
});

describe("InMemoryRelationStore.listRelated・listRelatedMany: 型の外の偽の kind は絞り込まず全件を返す（Postgres と同じ）", () => {
  it.each([[""], [null], [0]])("kind = %j", async (kind) => {
    const { relationStore, make } = await setup();
    const a = await make();
    const b = await make();
    await relationStore.link(ctx, "contradicts", a, b);
    const falsy = kind as unknown as RelationKind;
    expect((await relationStore.listRelated(ctx, a, falsy)).map((r) => r.memoryId)).toEqual([b]);
    expect(
      (await relationStore.listRelatedMany(ctx, [a], falsy)).map((rs) => rs.map((r) => r.memoryId)),
    ).toEqual([[b]]);
  });
});
