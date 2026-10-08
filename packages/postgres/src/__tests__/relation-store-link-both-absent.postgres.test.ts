import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
/** `PostgresRelationStore.link` は、両端とも存在しないとき `fromId` 側を報告する（どちらか一方だけ無いときは、その無い側）。 */

const ctx: Ctx = { tenantId: "relation-link-both-absent" };
const ABSENT_FROM = "00000000-0000-4000-8000-0000000000f1" as MemoryId;
const ABSENT_TO = "00000000-0000-4000-8000-0000000000f2" as MemoryId;
const MALFORMED = "not-a-uuid" as MemoryId;

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function thrownOf(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await run().catch((e: unknown) => {
    thrown = e;
  });
  return thrown;
}

describe("PostgresRelationStore.link: 存在しない端の報告（ADR 0571 の A3）", () => {
  it("両端とも存在しないときは、fromId 側を報告する（toId ではない）", async () => {
    const { db } = await getTestClient();
    const rs = new PostgresRelationStore(db);
    const thrown = await thrownOf(() => rs.link(ctx, "contradicts", ABSENT_FROM, ABSENT_TO));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      `PostgresRelationStore: memory not found for tenant: ${ABSENT_FROM}`,
    );
  });

  it("対照: 片方だけ無いときは、無い側を報告する（from が在って to が無い・from が無くて to が在る）", async () => {
    const { db } = await getTestClient();
    const rs = new PostgresRelationStore(db);
    const exists = (
      await new PostgresMemoryStore(db).createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-link-absent" }),
      )
    ).id;
    const toAbsent = await thrownOf(() => rs.link(ctx, "contradicts", exists, ABSENT_TO));
    expect((toAbsent as Error).message).toBe(
      `PostgresRelationStore: memory not found for tenant: ${ABSENT_TO}`,
    );
    const fromAbsent = await thrownOf(() => rs.link(ctx, "contradicts", ABSENT_FROM, exists));
    expect((fromAbsent as Error).message).toBe(
      `PostgresRelationStore: memory not found for tenant: ${ABSENT_FROM}`,
    );
  });

  // uuid の形でない端は DB へ投げる前に断る別の枝なので、上の2本（uuid の形をした id）とは別に見る。
  it("uuid の形でない端も、その端の id を報告する（片方だけが uuid の形でない）", async () => {
    const { db } = await getTestClient();
    const rs = new PostgresRelationStore(db);
    const exists = (
      await new PostgresMemoryStore(db).createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-link-malformed" }),
      )
    ).id;
    const toMalformed = await thrownOf(() => rs.link(ctx, "contradicts", exists, MALFORMED));
    expect((toMalformed as Error).message).toBe(
      `PostgresRelationStore: memory not found for tenant: ${MALFORMED}`,
    );
    const fromMalformed = await thrownOf(() => rs.link(ctx, "contradicts", MALFORMED, exists));
    expect((fromMalformed as Error).message).toBe(
      `PostgresRelationStore: memory not found for tenant: ${MALFORMED}`,
    );
  });
});
