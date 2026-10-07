import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, Memory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "validity-survives-writes" };
const VALID_FROM = new Date("2026-01-01T00:00:00.000Z");
const VALID_UNTIL = new Date("2026-12-31T00:00:00.000Z");

async function createWithValidity(store: PostgresMemoryStore, status: "active" | "archived") {
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `v-${randomUUID()}`,
      status,
      recordedAt: new Date("2026-02-01T00:00:00.000Z"),
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
    }),
  );
}

function expectValidityUnchanged(memory: Memory | null | undefined) {
  expect(memory?.validFrom).toEqual(VALID_FROM);
  expect(memory?.validUntil).toEqual(VALID_UNTIL);
}

describe("PostgresMemoryStore: 作成後の書き込みは validFrom/validUntil を動かさない", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("updateStatus", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await createWithValidity(store, "active");

    expectValidityUnchanged(await store.updateStatus(ctx, memory.id, "archived"));
    expectValidityUnchanged(await store.get(ctx, memory.id));
  });

  it("updateStatusWithEvent（archived から active への復帰を含む）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await createWithValidity(store, "archived");

    const { memory: restored } = await store.updateStatusWithEvent(
      ctx,
      memory.id,
      "active",
      { expectedStatus: "archived" },
      {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "restored",
        actor: { type: "system" },
        meta: {},
      },
    );

    expectValidityUnchanged(restored);
    expectValidityUnchanged(await store.get(ctx, memory.id));
  });

  it("reinforce", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await createWithValidity(store, "active");

    expectValidityUnchanged(
      await store.reinforce(ctx, memory.id, new Date("2026-03-01T00:00:00.000Z")),
    );
    expectValidityUnchanged(await store.get(ctx, memory.id));
  });

  it("purgeMemory（forgotten にしたあとの墓石化）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await createWithValidity(store, "active");
    await store.updateStatus(ctx, memory.id, "forgotten");

    const { memory: purged } = await store.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "purged",
        actor: { type: "system" },
        meta: {},
      },
    );

    expectValidityUnchanged(purged);
  });
});
