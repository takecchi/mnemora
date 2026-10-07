import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, MemoryId, VectorFilter, VectorHit } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { assertSafeIdentifier, embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { captureClientQuery, closeTestClient, getTestClient } from "./test-db.js";

/**
 * `search()` の統計が無い場面の枝（`buildStatsMissingBranches`）と、統計がある場面の枝（`buildStatsPresentBranches`）は、同じデータ・同じ `filter` に対して結果が完全に一致する。
 * `memories` の引き方（主キー経由か素の `JOIN` か）はあくまでプランの形の選び方であり、`filter` が指す集合・順序・同点の決着には影響しない、という契約を縛る。
 *
 * ## 手立て
 *
 * 同じテナント・同じ行に対して、新しい `PostgresVectorStore` インスタンスを2つ使う。
 * 1つ目は一度も `ANALYZE` していない状態で呼ぶ（`StatsPresenceGate` が未確認 → `reltuples < 0` を見て統計が無い場面の枝を選ぶ）。
 * そのあとテスト側で明示的に `ANALYZE` を打ち、2つ目の新しいインスタンス（`StatsPresenceGate` を共有しない。`search-stats-presence-scope.postgres.test.ts` が縛るとおり）で同じクエリを呼ぶ
 * （今度は `reltuples >= 0` を見て統計がある場面の枝を選ぶ）。
 *
 * どちらの枝が実際に選ばれたかは、送った SQL のテキストに `OFFSET 0`（統計が無い場面の枝に特有）が含まれるかどうかで検算する。
 * この検算が無いと、たまたま両方の実行が同じ枝を選んでいただけ、という空振りの歯になりうる。
 */

const TENANT = `stats-presence-result-eq-${randomUUID()}`;
const OTHER_TENANT = `stats-presence-result-eq-other-${randomUUID()}`;

function alias(memoryId: string, aliasMap: Map<string, string>): string {
  return aliasMap.get(memoryId) ?? `<${memoryId}>`;
}

function hits(list: VectorHit[], aliasMap: Map<string, string>): Array<[string, number]> {
  return list.map((h) => [alias(h.memoryId, aliasMap), h.distance]);
}

interface Scenario {
  name: string;
  query: number[];
  opts: { limit: number; filter: VectorFilter };
}

describe("search(): 統計が無い枝（候補D）と統計がある枝（今日のSQL）の結果一致（Issue #1415 / ADR 0374）", () => {
  let space: EmbeddingSpaceId;
  let table: string;
  const aliasMap = new Map<string, string>();

  beforeAll(async () => {
    const { db, pool } = await getTestClient();
    space = {
      provider: "test-issue-1415",
      model: `result-eq-${randomUUID()}`,
      dimensions: 3,
    };
    table = embeddingSpaceTableName(space);
    await registerEmbeddingSpace(pool, space);
    assertSafeIdentifier(table);

    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const other: Ctx = { tenantId: OTHER_TENANT };

    const put = async (
      name: string,
      vector: number[],
      over: Parameters<typeof buildNewMemoryFixture>[0] = {},
      c = ctx,
    ) => {
      const memory = await memoryStore.createMemory(
        c,
        buildNewMemoryFixture({ tenantId: c.tenantId, contentHash: name, ...over }),
      );
      await vectorStore.upsert(c, space, memory.id, vector);
      aliasMap.set(memory.id as MemoryId, name);
    };

    await put("m1", [1, 0, 0], {
      subjectId: "s1",
      tags: ["a"],
      attributes: { team: "x" },
      occurredAt: new Date("2026-01-10T00:00:00.000Z"),
    });
    // m1 と同じベクトル（距離の同点）。recorded_at で並ぶ。
    await put("m2", [1, 0, 0], { recordedAt: new Date("2026-01-02T00:00:00.000Z") });
    await put("m3", [0, 1, 0], { status: "archived", subjectId: "s2" });
    await put("m4", [1, 1, 0], {});
    await put("m5", [0, 0, 1], {
      validFrom: new Date("2026-01-10T00:00:00.000Z"),
      validUntil: new Date("2026-01-20T00:00:00.000Z"),
      tags: ["b"],
    });
    await put("m6", [1, 0, 1], {
      decayFloorAt: new Date("2026-01-05T00:00:00.000Z"),
      decayBaseSeq: 0,
      decayFloorSeq: 5,
      halfLifeRecalls: 5,
    });
    await put("m7", [-1, 0, 0], { occurredAt: new Date("2026-01-03T00:00:00.000Z") });
    await put("m8", [0, 0, 0], {});
    await put("o1", [1, 0, 0], {}, other);

    // 幅を実データに寄せて、極端に小さい表でプランの見積もりが拮抗しないようにする
    // （`search-primary-key-lookup.postgres.test.ts` のクラス doc コメントと同じ理由）。
    for (let i = 0; i < 100; i += 1) {
      await put(`filler-${i}`, [(i % 5) - 2, ((i * 3) % 5) - 2, ((i * 7) % 5) - 2], {
        content: `stats-presence-result-eq filler #${i} — ${"本文をある程度の長さにする".repeat(4)}`,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await closeTestClient();
  });

  const filter = (extra: Partial<VectorFilter> = {}): VectorFilter => ({
    tenantId: TENANT,
    ...extra,
  });

  const scenarios: Scenario[] = [
    { name: "tenantId だけ", query: [1, 0, 0], opts: { limit: 10, filter: filter() } },
    {
      name: "status:[active]",
      query: [1, 0, 0],
      opts: { limit: 10, filter: filter({ status: ["active"] }) },
    },
    {
      name: "status:[archived]",
      query: [0, 1, 0],
      opts: { limit: 10, filter: filter({ status: ["archived"] }) },
    },
    {
      name: "subjectId:s1",
      query: [1, 0, 0],
      opts: { limit: 10, filter: filter({ subjectId: "s1" }) },
    },
    {
      name: "subjectId:s1+includeSubjectless",
      query: [1, 0, 0],
      opts: { limit: 10, filter: filter({ subjectId: "s1", includeSubjectless: true }) },
    },
    {
      name: "attributes:{team:x}",
      query: [1, 0, 0],
      opts: { limit: 10, filter: filter({ attributes: { team: "x" } }) },
    },
    {
      name: "labels:[a]",
      query: [1, 0, 0],
      opts: { limit: 10, filter: filter({ labels: ["a"] }) },
    },
    {
      name: "occurredAfter",
      query: [1, 0, 0],
      opts: {
        limit: 10,
        filter: filter({ occurredAfter: new Date("2026-01-05T00:00:00.000Z") }),
      },
    },
    {
      name: "validAt",
      query: [0, 0, 1],
      opts: { limit: 10, filter: filter({ validAt: new Date("2026-01-15T00:00:00.000Z") }) },
    },
    {
      name: "excludeProvenanceKinds:[consolidated]",
      query: [1, 1, 0],
      opts: { limit: 10, filter: filter({ excludeProvenanceKinds: ["consolidated"] }) },
    },
    { name: "limit:2", query: [1, 0, 0], opts: { limit: 2, filter: filter() } },
    {
      name: "ゼロベクトル（比較不能）を含む上位",
      query: [0, 0, 0],
      opts: { limit: 10, filter: filter() },
    },
    {
      name: "tenantId:other（食い違い、0件）",
      query: [1, 0, 0],
      opts: { limit: 10, filter: filter({ tenantId: OTHER_TENANT }) },
    },
  ];

  it("候補D の枝（統計無し）と今日の枝（統計あり）が、同じシナリオで完全に同じ結果を返す", async () => {
    const ctx: Ctx = { tenantId: TENANT };

    // 1本目: 一度も ANALYZE していない、新しいインスタンス。統計が無い場面の枝を選ぶはず。
    const unanalyzedStore = new PostgresVectorStore((await getTestClient()).db);
    const unanalyzedResults = new Map<string, VectorHit[]>();
    let unanalyzedUsedCandidateD = false;
    for (const scenario of scenarios) {
      let result: VectorHit[] = [];
      const captured = await captureClientQuery(
        (text) => text.includes(table) && /combined/i.test(text),
        async () => {
          result = await unanalyzedStore.search(ctx, space, scenario.query, scenario.opts);
        },
      );
      if (/OFFSET 0/i.test(captured.text)) {
        unanalyzedUsedCandidateD = true;
      }
      unanalyzedResults.set(scenario.name, result);
    }
    expect(
      unanalyzedUsedCandidateD,
      "この歯の前提が崩れている——1本目は一度も候補D（OFFSET 0）の枝を選ばなかった",
    ).toBe(true);

    const { pool } = await getTestClient();
    await pool.query(`ANALYZE ${table}`);
    await pool.query(`ANALYZE memories`);

    // 2本目: ANALYZE 後の、まったく新しいインスタンス。素の JOIN を選ぶはず。
    const analyzedStore = new PostgresVectorStore((await getTestClient()).db);
    const analyzedResults = new Map<string, VectorHit[]>();
    let analyzedUsedCandidateD = false;
    for (const scenario of scenarios) {
      let result: VectorHit[] = [];
      const captured = await captureClientQuery(
        (text) => text.includes(table) && /combined/i.test(text),
        async () => {
          result = await analyzedStore.search(ctx, space, scenario.query, scenario.opts);
        },
      );
      if (/OFFSET 0/i.test(captured.text)) {
        analyzedUsedCandidateD = true;
      }
      analyzedResults.set(scenario.name, result);
    }
    expect(
      analyzedUsedCandidateD,
      "この歯の前提が崩れている——2本目（ANALYZE 後）が候補D の枝を選んでしまった",
    ).toBe(false);

    const mismatches: string[] = [];
    for (const scenario of scenarios) {
      const before = hits(unanalyzedResults.get(scenario.name)!, aliasMap);
      const after = hits(analyzedResults.get(scenario.name)!, aliasMap);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        mismatches.push(
          `- ${scenario.name}\n    候補D: ${JSON.stringify(before)}\n    今日:  ${JSON.stringify(after)}`,
        );
      }
    }
    expect(mismatches, `結果が食い違うシナリオ:\n${mismatches.join("\n")}`).toEqual([]);
  }, 180_000);
});
