import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `listActiveClaimPredicates` は、同じ subject の `active` で claim key を持つ行の predicate を、**行を余計に落とさず**、
 * 代表行の新しい順に返す（interface の doc）。既存の試験は claim key の subject がどれも同じ値で、有効期間も持たず、
 * 1つの predicate は1行だけだった。そのため次の形は、索引の使い方を見る試験か、SQL の文面を見る試験でしか捕まらなかった:
 * - claim key の subject が特定の値の行だけを数える。
 * - 有効期間が過ぎた `active` の行を落とす。
 * - 「新しい順」の前に、行数の多い predicate を先に並べる。
 */

const ctx: Ctx = { tenantId: "claim-predicates-from-every-active-row" };

describe("listActiveClaimPredicates は、active で claim key を持つ行を余計に落とさず、新しい順に返す", () => {
  let store: PostgresMemoryStore;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function create(hash: string, over: Parameters<typeof buildNewMemoryFixture>[0]) {
    return store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "user-1",
        contentHash: hash,
        ...over,
      }),
    );
  }

  it("claim key の subject が何であっても、その行の predicate は一覧に出る", async () => {
    await create("h-alice", { claimKey: { subject: "alice", predicate: "likes" } });
    await create("h-office", { claimKey: { subject: "office", predicate: "located_in" } });

    const predicates = await store.listActiveClaimPredicates(ctx, {
      subjectId: "user-1",
      limit: 10,
    });
    expect([...predicates].sort()).toEqual(["likes", "located_in"]);
  });

  it("有効期間が過ぎていても、status が active の行の predicate は一覧に出る", async () => {
    await create("h-expired", {
      claimKey: { subject: "user", predicate: "lived_in" },
      validFrom: new Date("2019-01-01T00:00:00.000Z"),
      validUntil: new Date("2020-01-01T00:00:00.000Z"),
    });

    const predicates = await store.listActiveClaimPredicates(ctx, {
      subjectId: "user-1",
      limit: 10,
    });
    expect(predicates).toEqual(["lived_in"]);
  });

  it("並びは代表行の新しい順だけで決まり、predicate を持つ行の数には左右されない", async () => {
    // 古い predicate を3行、そのあとに新しい predicate を1行。行の数で並べると古いほうが先になる。
    for (const n of [1, 2, 3]) {
      await create(`h-old-${n}`, { claimKey: { subject: "user", predicate: "p-old" } });
    }
    await create("h-new", { claimKey: { subject: "user", predicate: "p-new" } });

    const predicates = await store.listActiveClaimPredicates(ctx, {
      subjectId: "user-1",
      limit: 10,
    });
    expect(predicates).toEqual(["p-new", "p-old"]);
  });
});
