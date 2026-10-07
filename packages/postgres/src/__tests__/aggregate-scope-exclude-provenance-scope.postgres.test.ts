import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Ctx, Provenance } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "agg-exclude-prov-scope-tenant" };
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };
const IN_PERIOD = new Date("2026-06-10T00:00:00.000Z");
const BEFORE_PERIOD = new Date("2026-01-01T00:00:00.000Z");

/** `fn` の実行中に pg へ発行された SQL の文面を集める（`recall-roundtrip-count.postgres.test.ts` と同じ差し込み方）。 */
async function captureStatements(fn: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const first = args[0];
    statements.push(
      typeof first === "string" ? first : String((first as { text?: unknown } | undefined)?.text),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return statements;
}

describe("PostgresMemoryStore.aggregateScope × excludeProvenanceKinds: 絞りの内側だけを数える・skip では SQL を足さない（Issue #1734 / PR #1458 のすり抜け、本物の Postgres）", () => {
  let memoryStore: PostgresMemoryStore;

  beforeEach(async () => {
    const client = await getTestClient();
    memoryStore = new PostgresMemoryStore(client.db);
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function put(overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) {
    return memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `exclude-prov-scope-${Math.random()}`,
        subjectId: "s1",
        tags: ["alpha"],
        recordedAt: IN_PERIOD,
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"), // 忘却ゲートに掛からない
        embeddingStatus: "ready",
        ...overrides,
      }),
    );
  }

  async function seed() {
    await put({ provenance: consolidated });
    await put({ provenance: consolidated });
    await put({ provenance: consolidated, status: "archived" });
    await put({ provenance: consolidated, subjectId: "s2" });
    await put({ provenance: consolidated, recordedAt: BEFORE_PERIOD });
    await put({ provenance: consolidated, tags: ["beta"] });
    await put();
  }

  const scope = {
    subjectId: "s1",
    labels: ["alpha"],
    occurredAfter: new Date("2026-06-01T00:00:00.000Z"),
  };

  it("labels・archived・別 subject・期間の外の行は、除外 kind でも数えない", async () => {
    await seed();
    const aggregate = await memoryStore.aggregateScope(ctx, scope, {
      excludeProvenanceKinds: ["consolidated"],
    });
    expect(aggregate.excludedProvenanceIndexedCount).toBe(2);
    expect(aggregate.totalInScope).toBe(3);
    expect(aggregate.filteredArchived.count).toBe(1);
    expect(aggregate.filteredTaxonomy?.count).toBe(1);
  });

  it("scopeAggregate: 'skip'・digestBand 無しは、除外を指定しても SQL を1本も撃たない", async () => {
    await seed();
    const statements = await captureStatements(() =>
      memoryStore.aggregateScope(ctx, scope, {
        scopeAggregate: "skip",
        excludeProvenanceKinds: ["consolidated"],
      }),
    );
    expect(statements).toEqual([]);
  });

  it("scopeAggregate: 'skip'・digestBand 付きは、撃つ SQL が除外の指定の有無で変わらない（digest を引く1本だけ）", async () => {
    await seed();
    const digestBand = { limit: 10, excludeMemoryIds: [] };
    const withoutExclude = await captureStatements(() =>
      memoryStore.aggregateScope(ctx, scope, { scopeAggregate: "skip", digestBand }),
    );
    const withExclude = await captureStatements(() =>
      memoryStore.aggregateScope(ctx, scope, {
        scopeAggregate: "skip",
        digestBand,
        excludeProvenanceKinds: ["consolidated"],
      }),
    );
    expect(withoutExclude).toHaveLength(1);
    expect(withExclude).toEqual(withoutExclude);
    // 対照（探り棒が生きていること）: exact では除外の指定で集計の文面が変わる
    const exactWith = await captureStatements(() =>
      memoryStore.aggregateScope(ctx, scope, { excludeProvenanceKinds: ["consolidated"] }),
    );
    expect(exactWith.length).toBeGreaterThan(0);
    expect(exactWith.some((s) => s.includes("provenance_kind"))).toBe(true);
  });
});
