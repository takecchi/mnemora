import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, RecallScope } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  countMatchingQueries,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `PostgresMemoryStore.aggregateScope` の `scopeAggregate: "skip"` は、件数集計（`GROUP BY subject_id`）を
 * 止める代わりに、目次帯（`digestBand`）だけを別の `SELECT` で引く。この目次帯は、`"exact"` の目次帯と
 * 中身・順序・件数が1バイトも違ってはならない（`"skip"` は件数を捨てるだけで、帯の選び方は変えない）。
 *
 * `memory-store-conformance.ts` には足さない（外部 adapter へ要求を増やさない）。`conformance.postgres.test.ts` の
 * `"skip"` の歯は記憶が1件・絞りなしで、帯の絞り込み（subject・attributes・labels・期間・有効期間）・順序の
 * 同点の決め方・件数の上限・除外 id・`contested` を見ていなかった。ここでは `"exact"` を物差しに、同じ入力で
 * `"skip"` の帯が一致することを縛る。物差し側（`"exact"`）が両方揃って壊れる偽陽性を避けるため、
 * 「期待する id の列」を JS で独立に組み、`"exact"` の側にも当てる。
 */

const TENANT = "skip-digest-band-tenant";
const TIE_COUNT = 10;
const ctx: Ctx = { tenantId: TENANT };

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-03-01T00:00:00.000Z").getTime();
const day = (n: number) => new Date(T0 + n * DAY);

interface Row {
  id: MemoryId;
  effTime: number;
}

describe("PostgresMemoryStore.aggregateScope: scopeAggregate 'skip' の目次帯は 'exact' と同じ（本物の Postgres）", () => {
  let store: PostgresMemoryStore;
  let scanStore: PostgresMemoryStore;
  let scanClient: PostgresClient;
  const rows = new Map<string, Row>();
  let serial = 0;

  async function put(
    label: string,
    overrides: Parameters<typeof buildNewMemoryFixture>[0],
    effTime: Date,
  ): Promise<void> {
    serial += 1;
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `skip-digest-band-${serial}`,
        digest: `digest-${label}`,
        recordedAt: effTime,
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
        ...overrides,
      }),
    );
    // 実効時刻は occurredAt ?? recordedAt。
    rows.set(label, { id: memory.id, effTime: (overrides?.occurredAt ?? effTime).getTime() });
  }

  beforeAll(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    store = new PostgresMemoryStore(db);
    scanClient = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      options: "-c enable_indexscan=off -c enable_indexonlyscan=off -c enable_bitmapscan=off",
    });
    scanStore = new PostgresMemoryStore(scanClient.db);

    // 実効時刻が同じ10件（id の降順で決まる）。上限の線がこの塊の途中を通る。
    for (let i = 0; i < TIE_COUNT; i += 1) {
      await put(`tie-${i}`, { subjectId: "s1", tags: ["alpha"], attributes: { k: "v" } }, day(10));
    }
    // contested は帯に入る（対のまま。`markContestedPair` でしか作れない）。新しいほうの2件。
    const claimKey = { subject: "user", predicate: "skip-digest-band" };
    for (const [label, at] of [
      ["contested", day(20)],
      ["contested-b", day(19)],
    ] as const) {
      await put(label, { subjectId: "s1", tags: ["alpha"], attributes: { k: "v" }, claimKey }, at);
    }
    const a = rows.get("contested")!.id;
    const b = rows.get("contested-b")!.id;
    await store.markContestedPair(
      ctx,
      { id: a, event: buildNewMemoryEventFixture({ memoryId: a, kind: "updated" }) },
      { id: b, event: buildNewMemoryEventFixture({ memoryId: b, kind: "updated" }) },
    );
    // active・別の subject・別の attributes・別のラベル。
    await put("s2", { subjectId: "s2", tags: ["beta"], attributes: { k: "w" } }, day(15));
    await put("subjectless", { subjectId: null, tags: [], attributes: {} }, day(14));
    // occurredAt が recordedAt より古い: 実効時刻は occurredAt（COALESCE の左）。
    await put(
      "occurred-old",
      { subjectId: "s1", tags: ["alpha"], attributes: { k: "v" }, occurredAt: day(2) },
      day(40),
    );
    // 有効期間: validAt = day(30) で、片方は終わっており、片方はまだ始まっていない。
    await put(
      "expired",
      { subjectId: "s1", tags: ["alpha"], attributes: { k: "v" }, validUntil: day(25) },
      day(12),
    );
    await put(
      "not-yet-valid",
      { subjectId: "s1", tags: ["alpha"], attributes: { k: "v" }, validFrom: day(35) },
      day(13),
    );
    // 帯に入らない status。どれも実効時刻はいちばん新しい。
    await put("archived", { status: "archived", subjectId: "s1", tags: ["alpha"] }, day(50));
    await put("superseded", { status: "superseded", subjectId: "s1", tags: ["alpha"] }, day(51));
    await put("forgotten", { status: "forgotten", subjectId: "s1", tags: ["alpha"] }, day(52));
  }, 60_000);

  afterAll(async () => {
    await scanClient.pool.end();
    await closeTestClient();
  });

  /** 期待する id の列を、JS で独立に組む: 実効時刻の降順、同じなら id の降順。 */
  function expectedIds(labels: string[]): MemoryId[] {
    return labels
      .map((l) => rows.get(l)!)
      .sort((a, b) => (a.effTime !== b.effTime ? b.effTime - a.effTime : a.id < b.id ? 1 : -1))
      .map((r) => r.id);
  }

  const allBandLabels = [
    ...Array.from({ length: TIE_COUNT }, (_, i) => `tie-${i}`),
    "contested",
    "contested-b",
    "s2",
    "subjectless",
    "occurred-old",
    "expired",
    "not-yet-valid",
  ];

  async function bands(
    scope: RecallScope,
    limit: number,
    excludeLabels: string[] = [],
  ): Promise<{ skip: MemoryId[]; exact: MemoryId[] }> {
    const digestBand = {
      limit,
      excludeMemoryIds: excludeLabels.map((l) => rows.get(l)!.id),
    };
    const skip = await store.aggregateScope(ctx, scope, { scopeAggregate: "skip", digestBand });
    const exact = await store.aggregateScope(ctx, scope, { scopeAggregate: "exact", digestBand });
    expect(skip.countKind).toBe("unknown");
    expect(exact.countKind).toBe("exact");
    // 中身（digest 本文）も同じ。
    expect(skip.digests).toEqual(exact.digests);
    // 索引を使えない接続（Seq Scan + Sort しか選べない）でも同じ。索引が `id DESC` の順を
    // 持っているので、索引が使える計画だけを見ていると、ORDER BY の同点の決め方が抜けても気づけない。
    const skipWithoutIndex = await scanStore.aggregateScope(ctx, scope, {
      scopeAggregate: "skip",
      digestBand,
    });
    expect(skipWithoutIndex.digests).toEqual(exact.digests);
    return {
      skip: skip.digests.map((d) => d.memoryId),
      exact: exact.digests.map((d) => d.memoryId),
    };
  }

  it("絞りなし・上限が十分: active と contested だけが、実効時刻の降順・同じなら id の降順で出る", async () => {
    const { skip, exact } = await bands({}, 100);
    // occurred-old は実効時刻 day(2) で最後に来る。
    const expected = expectedIds(allBandLabels);
    expect(expected.at(-1)).toBe(rows.get("occurred-old")!.id);
    expect(exact).toEqual(expected);
    expect(skip).toEqual(expected);
    expect(skip).toContain(rows.get("contested")!.id);
    for (const gone of ["archived", "superseded", "forgotten"]) {
      expect(skip).not.toContain(rows.get(gone)!.id);
    }
  });

  it("上限が同じ実効時刻の塊の途中を通っても、id の降順で切れる。件数は上限ちょうど", async () => {
    // contested(day20), contested-b(day19), s2(day15), subjectless(day14), not-yet-valid(day13), expired(day12)
    // の次に、実効時刻が同じ tie が10件（7番目から16番目まで）。
    for (const limit of [6, 7, 8, 10, 12, 15, 16, 17]) {
      const { skip, exact } = await bands({}, limit);
      const expectedAll = expectedIds(allBandLabels);
      expect(skip, `limit=${limit}`).toHaveLength(limit);
      expect(skip, `limit=${limit}`).toEqual(expectedAll.slice(0, limit));
      expect(exact, `limit=${limit}`).toEqual(expectedAll.slice(0, limit));
    }
  });

  it("上限 0 は空", async () => {
    const { skip, exact } = await bands({}, 0);
    expect(exact).toEqual([]);
    expect(skip).toEqual([]);
  });

  it("除外 id は帯に出ない（除外したぶん、後ろの行が繰り上がる）", async () => {
    const { skip, exact } = await bands({}, 3, ["contested", "s2"]);
    const expected = expectedIds(allBandLabels).filter(
      (id) => id !== rows.get("contested")!.id && id !== rows.get("s2")!.id,
    );
    expect(exact).toEqual(expected.slice(0, 3));
    expect(skip).toEqual(expected.slice(0, 3));
  });

  it("scope.subjectId の絞り: その subject の行だけ", async () => {
    const { skip, exact } = await bands({ subjectId: "s2" }, 100);
    expect(exact).toEqual([rows.get("s2")!.id]);
    expect(skip).toEqual([rows.get("s2")!.id]);
  });

  it("scope.attributes の絞り: 包含する行だけ", async () => {
    const { skip, exact } = await bands({ attributes: { k: "w" } }, 100);
    expect(exact).toEqual([rows.get("s2")!.id]);
    expect(skip).toEqual([rows.get("s2")!.id]);
  });

  it("scope.labels の絞り: そのタグを持つ行だけ", async () => {
    const { skip, exact } = await bands({ labels: ["beta"] }, 100);
    expect(exact).toEqual([rows.get("s2")!.id]);
    expect(skip).toEqual([rows.get("s2")!.id]);
  });

  it("期間の絞り（occurredAfter / occurredBefore）: 実効時刻（occurredAt ?? recordedAt）で切る", async () => {
    const { skip, exact } = await bands({ occurredAfter: day(13), occurredBefore: day(16) }, 100);
    const expected = expectedIds(["s2", "subjectless", "not-yet-valid"]);
    expect(exact).toEqual(expected);
    expect(skip).toEqual(expected);
    // occurredAt が古い行は、recordedAt が新しくても期間の外。
    expect(skip).not.toContain(rows.get("occurred-old")!.id);
  });

  it("有効期間の絞り（validAt）: 終わった行・まだ始まっていない行は出ない", async () => {
    const { skip, exact } = await bands({ validAt: day(30) }, 100);
    const expected = expectedIds(
      allBandLabels.filter((l) => l !== "expired" && l !== "not-yet-valid"),
    );
    expect(exact).toEqual(expected);
    expect(skip).toEqual(expected);
  });

  describe("集計を実際に払わない（digestBand を渡したときも）", () => {
    it("skip + digestBand: 件数集計（GROUP BY・count）を含む SQL を発行せず、memories への問い合わせは1本だけ", async () => {
      const digestBand = { limit: 5, excludeMemoryIds: [] };
      const groupBy = await countMatchingQueries(
        (text) => /group by/i.test(text),
        () => store.aggregateScope(ctx, {}, { scopeAggregate: "skip", digestBand }),
      );
      const counts = await countMatchingQueries(
        (text) => /count\s*\(/i.test(text),
        () => store.aggregateScope(ctx, {}, { scopeAggregate: "skip", digestBand }),
      );
      const memoriesReads = await countMatchingQueries(
        (text) => /from\s+"?memories"?/i.test(text),
        () => store.aggregateScope(ctx, {}, { scopeAggregate: "skip", digestBand }),
      );
      expect(groupBy).toBe(0);
      expect(counts).toBe(0);
      expect(memoriesReads).toBe(1);
    });

    it("対照: exact + digestBand は GROUP BY を含む SQL を発行する（この計測が空振りしていない）", async () => {
      const groupBy = await countMatchingQueries(
        (text) => /group by/i.test(text),
        () =>
          store.aggregateScope(
            ctx,
            {},
            { scopeAggregate: "exact", digestBand: { limit: 5, excludeMemoryIds: [] } },
          ),
      );
      expect(groupBy).toBeGreaterThan(0);
    });
  });

  describe("skip + scope.taxonomyGroupCandidates: taxonomy の群も数えない", () => {
    it("groups は空、件数は unknown / 0（集計の SQL も発行しない）。帯は出る", async () => {
      const scope: RecallScope = { taxonomyGroupCandidates: ["alpha", "beta"] };
      let result: Awaited<ReturnType<PostgresMemoryStore["aggregateScope"]>> | undefined;
      const groupBy = await countMatchingQueries(
        (text) => /group by/i.test(text),
        async () => {
          result = await store.aggregateScope(ctx, scope, {
            scopeAggregate: "skip",
            digestBand: { limit: 3, excludeMemoryIds: [] },
          });
        },
      );
      expect(groupBy).toBe(0);
      expect(result!.groups).toEqual([]);
      expect(result!.totalInScope).toBe(0);
      expect(result!.countKind).toBe("unknown");
      expect(result!.filteredTaxonomy).toEqual({ count: 0, countKind: "unknown" });
      expect(result!.digests).toHaveLength(3);
    });

    it("対照: exact なら taxonomy の群が出る", async () => {
      const result = await store.aggregateScope(
        ctx,
        { taxonomyGroupCandidates: ["alpha", "beta"] },
        { scopeAggregate: "exact" },
      );
      expect(result.groups.some((g) => g.axis === "taxonomy")).toBe(true);
    });
  });
});
