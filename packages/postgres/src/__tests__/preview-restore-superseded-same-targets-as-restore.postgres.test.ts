import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `previewRestoreSupersededBy` の対象の選び方は、`restoreSupersededBy` の `WHERE` と完全に一致させる（interface の doc。
 * ずれると「戻る前に見たものと、実際に戻ったものが違う」）。対象の条件は、テナント・`superseded_by_id`・`status = 'superseded'` の3つだけで、
 * **置き換えた側の行の今の status は見ない。**既存の試験は置き換えた側が `active` のままの群しか作らず、
 * preview だけが置き換えた側の status で絞る形が緑のまま通っていた。
 */

const ctx: Ctx = { tenantId: "preview-restore-superseded-same-targets-as-restore" };

describe("previewRestoreSupersededBy は、置き換えた側が active でなくなっていても restoreSupersededBy と同じ行を挙げる", () => {
  let store: PostgresMemoryStore;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("置き換えた側を forget した後でも、preview に挙がった行と実際に戻った行は同じ", async () => {
    const anchor = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-anchor" }),
    );
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-old" }),
    );
    await store.updateStatus(ctx, old.id, "superseded", { supersededById: anchor.id });
    await store.updateStatus(ctx, anchor.id, "forgotten");

    const preview = await store.previewRestoreSupersededBy(ctx, anchor.id);
    expect(preview.candidates.map((c) => c.memoryId)).toEqual([old.id]);

    const restored = await store.restoreSupersededBy(ctx, anchor.id, {
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(restored.restored.map((m) => m.id)).toEqual(preview.candidates.map((c) => c.memoryId));
  });
});
