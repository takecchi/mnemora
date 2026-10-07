import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "readme-exception-faces-1753" };
const A = "00000000-0000-4000-8000-00000000000a" as MemoryId;
const B = "00000000-0000-4000-8000-00000000000b" as MemoryId;

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function rejection(
  fn: () => Promise<unknown>,
): Promise<Error & { cause?: { code?: unknown } }> {
  try {
    await fn();
  } catch (err) {
    return err as Error & { cause?: { code?: unknown } };
  }
  throw new Error("例外にならなかった");
}

async function store(): Promise<PostgresMemoryStore> {
  const { db } = await getTestClient();
  return new PostgresMemoryStore(db);
}

describe("README「例外の見分け方」: 負の limit", () => {
  it("listActiveClaimPredicates・archiveDecayed は、行が無いテナントでも 2201W の DB が拒んだ例外", async () => {
    const s = await store();
    for (const fn of [
      () => s.listActiveClaimPredicates!(ctx, { subjectId: null, limit: -1 }),
      () => s.archiveDecayed(ctx, { now: new Date(), limit: -1 }),
    ]) {
      const err = await rejection(fn);
      expect(err.name).toBe("Error");
      expect(err.cause?.code).toBe("2201W");
    }
  });

  it("purgeExpiredEvents は、行が1本も無いテナントでは投げずに返る", async () => {
    const s = await store();
    await expect(
      s.purgeExpiredEvents(ctx, { olderThan: new Date(), limit: -1 }),
    ).resolves.toBeDefined();
  });
});

describe("README「例外の見分け方」: DB に触れる前に断る RangeError", () => {
  it("resolveContestedPair の型の外の status は、cause の無い RangeError", async () => {
    const s = await store();
    const event = { kind: "updated", actor: { type: "system" }, meta: {} } as never;
    const err = await rejection(() =>
      s.resolveContestedPair(
        ctx,
        { id: A, status: "forgotten" as never, event },
        { id: B, status: "active", event },
      ),
    );
    expect(err).toBeInstanceOf(RangeError);
    expect(err.cause).toBeUndefined();
  });
});
