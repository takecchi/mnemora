import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `setEmbeddingStatus` の巻き戻しの守りは「片側だけの規則」で、`ready` の行へ `failed` を書くのだけを弾く（`MemoryStore.setEmbeddingStatus` の doc「それ以外の遷移は今日どおり無条件」）。
 *
 * 適合テストは `ready → failed` が弾かれることと `failed → ready` が通ることだけを見る。守りを全 `status` へ掛ける誤り（`ready` の行へ `pending`・`ready` を書いても弾く）は、どれも赤にしなかった。
 * `ready → pending`（再投入）が黙って効かなくなると、リセット後の再埋め込みが走らない。
 */

const TENANT = "set-embedding-status-non-rollback-tenant";
const ctx: Ctx = { tenantId: TENANT };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

async function readyMemory(store: PostgresMemoryStore) {
  const memory = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
  );
  return store.setEmbeddingStatus(ctx, memory.id, "ready");
}

describe("PostgresMemoryStore.setEmbeddingStatus — 巻き戻しの守りは ready → failed だけ", () => {
  it("陽性対照: ready の行へ failed を書いても ready のまま（守りが効く）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ready = await readyMemory(store);

    const result = await store.setEmbeddingStatus(ctx, ready.id, "failed");

    expect(result.embeddingStatus).toBe("ready");
  });

  it("ready の行へ pending を書くと pending になる（再投入は弾かれない）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ready = await readyMemory(store);

    const result = await store.setEmbeddingStatus(ctx, ready.id, "pending");

    expect(result.embeddingStatus).toBe("pending");
    expect((await store.get(ctx, ready.id))?.embeddingStatus).toBe("pending");
  });

  it("ready の行へ ready を書いても例外にならず ready のまま、updatedAt が進む（無条件の遷移）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ready = await readyMemory(store);
    const before = (await store.get(ctx, ready.id))!;

    const result = await store.setEmbeddingStatus(ctx, ready.id, "ready");

    expect(result.embeddingStatus).toBe("ready");
    expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });
});
