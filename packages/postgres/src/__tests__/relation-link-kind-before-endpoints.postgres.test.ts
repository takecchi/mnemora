// `RelationStore.link` は、範囲外の kind を両端の検査より前に `unknown relation kind` で断る（`PostgresRelationStore.link` の TSDoc。fixture の `InMemoryRelationStore` が揃える先）。
// 既存の relation-store-parity は両端が在る入力でしか kind を試さないので、fixture の検査の位置を両端の検査の後ろへ動かしても赤にならない。ここで、端の記憶が無い入力で縛る。
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, MemoryStore, RelationKind, RelationStore } from "@mnemora/core";
import { InMemoryMemoryStore, InMemoryRelationStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "relation-link-kind-order" };
const ghost = "00000000-0000-4000-8000-000000000001" as MemoryId;

interface Kit {
  memoryStore: MemoryStore;
  relationStore: RelationStore;
}

const kits: Array<[string, () => Promise<Kit>]> = [
  [
    "postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return {
        memoryStore: new PostgresMemoryStore(db),
        relationStore: new PostgresRelationStore(db),
      };
    },
  ],
  [
    "testkit の fixture",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return { memoryStore, relationStore: new InMemoryRelationStore(memoryStore) };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(kits)("link: 範囲外の kind は両端の検査より前に断る: %s", (_name, build) => {
  it.each(["bogus", "", null])("端の記憶が無くても unknown relation kind (%j)", async (kind) => {
    const kit = await build();
    await expect(
      kit.relationStore.link(ctx, kind as unknown as RelationKind, ghost, ghost),
    ).rejects.toThrow(/unknown relation kind/);
  });

  it("正しい kind なら、端の記憶が無いことで断る（陽性対照）", async () => {
    const kit = await build();
    await expect(kit.relationStore.link(ctx, "contradicts", ghost, ghost)).rejects.toThrow(
      /memory not found for tenant/,
    );
  });
});
