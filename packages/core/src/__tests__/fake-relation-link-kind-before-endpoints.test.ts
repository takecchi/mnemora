// 両端の検査より前に範囲外の kind を断る。両端が在る入力でしか kind を試さないと、検査を両端の検査の後ろへ動かしても赤にならない。
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { RelationKind } from "../interfaces/relation-store.js";
import type { MemoryId } from "../ids.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-link-kind-order" };

describe("FakeRelationStore.link: 範囲外の kind は両端の検査より前に断る（ADR 0488）", () => {
  it.each(["bogus", "", null])("端の記憶が無くても unknown relation kind (%j)", async (kind) => {
    const stores = createFakeRuntimeStores();
    const ghost = "00000000-0000-4000-8000-000000000001" as MemoryId;
    await expect(
      stores.relationStore.link(ctx, kind as unknown as RelationKind, ghost, ghost),
    ).rejects.toThrow(/unknown relation kind/);
  });

  it("正しい kind なら、端の記憶が無いことで断る（陽性対照）", async () => {
    const stores = createFakeRuntimeStores();
    const ghost = "00000000-0000-4000-8000-000000000001" as MemoryId;
    await expect(stores.relationStore.link(ctx, "contradicts", ghost, ghost)).rejects.toThrow(
      /memory not found for tenant/,
    );
  });
});
