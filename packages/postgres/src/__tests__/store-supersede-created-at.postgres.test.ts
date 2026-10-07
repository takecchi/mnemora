import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `supersedeWithNewMemories` で置き換えた古い記憶の `createdAt` は変わらない（Postgres の脚）。
 * core の Fake と testkit の InMemory と同じ不変条件を、Postgres にも当てる。
 *
 * DB の `now()` は偽の時計で動かせないので、古い記憶の `created_at` を過去へ直接書き換えてから置き換える。
 * 置き換えの UPDATE が `created_at = now()` を書けば、過去の値とは必ず違う。
 */

const A: Ctx = { tenantId: "supersede-created-at-a" };
const PAST = new Date("2020-01-01T00:00:00.000Z");

afterAll(async () => {
  await closeTestClient();
});

describe("Postgres: supersedeWithNewMemories の古い記憶の createdAt は変わらない", () => {
  it("置き換えで updatedAt は進むが、createdAt は作ったときのまま（後から書き換わらない）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const old = await store.createMemory(
      A,
      buildNewMemoryFixture({ tenantId: A.tenantId, contentHash: "old-hash-created-at" }),
    );
    await db.execute(
      sql`UPDATE memories SET created_at = ${PAST.toISOString()}::timestamptz, updated_at = ${PAST.toISOString()}::timestamptz WHERE id = ${old.id}::uuid`,
    );
    const before = (await store.get(A, old.id))!;
    expect(before.createdAt).toEqual(PAST);
    const event: NewMemoryEvent = {
      tenantId: A.tenantId,
      memoryId: old.id as MemoryId,
      kind: "superseded",
      actor: { type: "system" },
      meta: { reason: "test" },
    };

    const result = await store.supersedeWithNewMemories(
      A,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: A.tenantId,
            contentHash: "new-hash-created-at",
          }),
          jobKinds: ["embed"],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event }],
    );

    expect(result.superseded).toHaveLength(1);
    const after = (await store.get(A, old.id))!;
    expect(after.status).toBe("superseded");
    expect(after.updatedAt.getTime()).toBeGreaterThan(PAST.getTime()); // 陽性対照: 置き換えは updatedAt を進める
    expect(after.createdAt).toEqual(PAST);
  });
});

describe("Postgres: supersedeWithNewMemories で CAS に弾かれた行は updatedAt も createdAt も書き換わらない（ADR 0592。クローンの判断）", () => {
  it("expectedStatus が合わず conflicted に積まれた古い記憶は、置き換えの前後で updatedAt・createdAt が同じ", async () => {
    const MID = new Date("2020-06-01T00:00:00.000Z");
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const old = await store.createMemory(
      A,
      buildNewMemoryFixture({ tenantId: A.tenantId, contentHash: "old-hash-cas-conflict" }),
    );
    // 過去の値と status = 'archived' を直接書く（`now()` は偽の時計で動かせない）。
    await db.execute(
      sql`UPDATE memories SET created_at = ${PAST.toISOString()}::timestamptz, updated_at = ${MID.toISOString()}::timestamptz, status = 'archived' WHERE id = ${old.id}::uuid`,
    );
    const before = (await store.get(A, old.id))!;
    expect(before.status).toBe("archived");
    expect(before.createdAt).toEqual(PAST);
    expect(before.updatedAt).toEqual(MID);
    const event: NewMemoryEvent = {
      tenantId: A.tenantId,
      memoryId: old.id as MemoryId,
      kind: "superseded",
      actor: { type: "system" },
      meta: { reason: "test" },
    };

    const result = await store.supersedeWithNewMemories(
      A,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: A.tenantId,
            contentHash: "new-hash-cas-conflict",
          }),
          jobKinds: ["embed"],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event }], // 実際は archived なので弾かれる
    );

    expect(result.superseded).toEqual([]);
    expect(result.conflicted).toEqual([{ id: old.id, observedStatus: "archived" }]);
    const after = (await store.get(A, old.id))!;
    expect(after.status).toBe("archived");
    expect(after.updatedAt).toEqual(MID);
    expect(after.createdAt).toEqual(PAST);
  });
});
