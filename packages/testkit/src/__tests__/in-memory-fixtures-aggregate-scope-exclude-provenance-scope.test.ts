import { describe, expect, it } from "vitest";
import type { Ctx, Provenance } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）で、PR #1458（ADR 0390）の変異試験が**すり抜けた**
 * 「testkit が archived の行も数える」を塞ぐ歯。担当はクローン（miku）の判断で進めている作業であり、
 * オーナーの判断ではない。`in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts` の seed は
 * 全部 active・絞りなしで、絞りで落ちる行が無かった。**`memory-store-conformance.ts` には足さない**。
 *
 * `excludedProvenanceIndexedCount` は「除外する kind で、ready で、`totalInScope` と同じ絞りの内側の行」
 * を数える（ADR 0390 決定1・2）。archived・別 subject・期間の外・labels に合わない行は数えない。
 * 同じ形の歯が core の Fake と Postgres にも在る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };
const IN_PERIOD = new Date("2026-06-10T00:00:00.000Z");
const BEFORE_PERIOD = new Date("2026-01-01T00:00:00.000Z");

const scope = {
  subjectId: "s1",
  labels: ["alpha"],
  occurredAfter: new Date("2026-06-01T00:00:00.000Z"),
};

describe("InMemoryMemoryStore.aggregateScope: excludedProvenanceIndexedCount は totalInScope と同じ絞りの内側だけを数える（Issue #1734 / PR #1458 のすり抜け）", () => {
  async function seed() {
    const store = new InMemoryMemoryStore();
    let n = 0;
    const make = (extra: Record<string, unknown> = {}) => {
      n += 1;
      return store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `exclude-prov-scope-${n}`,
          subjectId: "s1",
          tags: ["alpha"],
          recordedAt: IN_PERIOD,
          decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
          embeddingStatus: "ready",
          ...extra,
        }),
      );
    };
    // 数える: スコープ内・active・ready・除外 kind
    await make({ provenance: consolidated });
    await make({ provenance: consolidated });
    // 数えない（絞りで落ちる行。どれも除外 kind・ready）
    await make({ provenance: consolidated, status: "archived" });
    await make({ provenance: consolidated, subjectId: "s2" });
    await make({ provenance: consolidated, recordedAt: BEFORE_PERIOD });
    await make({ provenance: consolidated, tags: ["beta"] });
    // 除外 kind ではない行（スコープ内）
    await make();
    return store;
  }

  it("archived・別 subject・期間の外・labels に合わない行は、除外 kind でも数えない", async () => {
    const store = await seed();
    const aggregate = await store.aggregateScope(ctx, scope, {
      excludeProvenanceKinds: ["consolidated"],
    });
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    // 対照: スコープ内の行は除外 kind の2件と、除外 kind でない1件（totalInScope の意味は変えない）
    expect(aggregate.totalInScope).toBe(3);
    expect(aggregate.filteredArchived.count).toBe(1);
  });
});
