// `InMemoryMemoryStore.aggregateScope` の `digestBand`（目次帯、ADR 0073 決定7）が、
// `scope.subjectId` × `scope.includeSubjectless`（`docs/recall.md`「includeSubjectless」節・
// ADR 0286）の絞りの内側だけを出すことを、Fake に対して実測で確認する。
//
// **`memory-store-conformance.ts`（適合テスト一式）には足さない**（Issue #809 の方針。
// 外部 adapter 実装者にまで要求を増やすため）。Postgres 側は
// `packages/postgres/src/__tests__/digest-band-subject.postgres.test.ts`。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "tenant-1" };

async function seed() {
  const store = new InMemoryMemoryStore();
  const make = (contentHash: string, subjectId: string | null) =>
    store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash, subjectId }),
    );
  const a = await make("digest-band-subject-a", "subject-a");
  const aExcluded = await make("digest-band-subject-a-excluded", "subject-a");
  const b = await make("digest-band-subject-b", "subject-b");
  const none = await make("digest-band-subject-null", null);
  return { store, a, aExcluded, b, none };
}

describe("InMemoryMemoryStore.aggregateScope の digestBand: subjectId × includeSubjectless（ADR 0286）", () => {
  it("subjectId だけを指定すると、digests と digestEligible はその subject の内側だけを数える", async () => {
    const { store, a, aExcluded } = await seed();
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
    const { store, a, aExcluded, none } = await seed();
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
    const { store, a, b } = await seed();
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
