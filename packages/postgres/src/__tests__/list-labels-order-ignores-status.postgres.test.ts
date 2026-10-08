import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `listLabels` の並びの保証は「`name` のコードポイント順の昇順」の1点だけである（interface の doc）。
 * 既存の並びの試験は `registered` と `proposed` を混ぜておらず、`status` で先に並べ替える形が緑のまま通っていた。
 */

const ctx: Ctx = { tenantId: "list-labels-order-ignores-status" };

describe("listLabels は status を混ぜても name の順だけで並べる", () => {
  let store: PostgresMemoryStore;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("registered と proposed が交互に並ぶ名前でも、name の昇順で返る", async () => {
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-1",
        tags: ["a-proposed", "c-proposed"],
      }),
    );
    await store.registerLabel(ctx, "b-registered");
    await store.registerLabel(ctx, "d-registered");

    const labels = await store.listLabels(ctx);
    expect(labels.map((l) => [l.name, l.status])).toEqual([
      ["a-proposed", "proposed"],
      ["b-registered", "registered"],
      ["c-proposed", "proposed"],
      ["d-registered", "registered"],
    ]);
  });
});
