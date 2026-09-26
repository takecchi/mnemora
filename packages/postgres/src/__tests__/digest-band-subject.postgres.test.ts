import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.aggregateScope` の `digestBand`（目次帯、ADR 0073 決定7）が、
 * `scope.subjectId` × `scope.includeSubjectless`（`docs/recall.md`「includeSubjectless」節・
 * ADR 0286）の絞りの内側だけを出すことの実測。
 *
 * `digests`/`digest_eligible_count` は `scoped`/`agg` を経由せず `memories` を直接引く
 * 別のサブクエリであり（Issue #355 / ADR 0307）、`totalInScope` 側の絞りとは独立に
 * 壊れうる。**`*-conformance.ts` には足さない**（外部 adapter への要件を増やさないため、
 * Issue #809 の方針）。Fake 側は
 * `packages/testkit/src/__tests__/in-memory-fixtures-digest-band-subject.test.ts`。
 */

const TENANT = "digest-band-subject-tenant";

async function seed() {
  const { db } = await getTestClient();
  const store = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  const make = (contentHash: string, subjectId: string | null) =>
    store.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT, contentHash, subjectId }));
  const a = await make("digest-band-subject-a", "subject-a");
  const aExcluded = await make("digest-band-subject-a-excluded", "subject-a");
  const b = await make("digest-band-subject-b", "subject-b");
  const none = await make("digest-band-subject-null", null);
  return { store, ctx, a, aExcluded, b, none };
}

describe("PostgresMemoryStore.aggregateScope の digestBand: subjectId × includeSubjectless（ADR 0286）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("subjectId だけを指定すると、digests と digestEligible はその subject の内側だけを数える", async () => {
    const { store, ctx, a, aExcluded } = await seed();
    const aggregate = await store.aggregateScope(
      ctx,
      { subjectId: "subject-a" },
      { digestBand: { limit: 50, excludeMemoryIds: [aExcluded.id] } },
    );
    expect(aggregate.digests.map((d) => d.memoryId)).toEqual([a.id]);
    expect(aggregate.digestEligible.count).toBe(1);
    expect(aggregate.totalInScope).toBe(2);
  });

  it("includeSubjectless: true では subjectless も digests と digestEligible に入り、別 subject は入らない", async () => {
    const { store, ctx, a, aExcluded, none } = await seed();
    const aggregate = await store.aggregateScope(
      ctx,
      { subjectId: "subject-a", includeSubjectless: true },
      { digestBand: { limit: 50, excludeMemoryIds: [aExcluded.id] } },
    );
    expect(aggregate.digests.map((d) => d.memoryId).sort()).toEqual([a.id, none.id].sort());
    expect(aggregate.digestEligible.count).toBe(2);
    expect(aggregate.totalInScope).toBe(3);
  });

  it("除外に別 subject の id を混ぜても、digestEligible は絞りの内側からしか引かれない", async () => {
    const { store, ctx, a, b } = await seed();
    const aggregate = await store.aggregateScope(
      ctx,
      { subjectId: "subject-a" },
      { digestBand: { limit: 50, excludeMemoryIds: [b.id] } },
    );
    expect(aggregate.digests.map((d) => d.memoryId)).toContain(a.id);
    expect(aggregate.digests.map((d) => d.memoryId)).not.toContain(b.id);
    expect(aggregate.digestEligible.count).toBe(2);
  });
});
