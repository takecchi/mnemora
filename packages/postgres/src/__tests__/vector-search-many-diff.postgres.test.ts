import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemory, VectorFilter, VectorHit } from "@mnemora/core";
import { buildNewMemoryFixture, buildProvenanceFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { closeTestClient, getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * `PostgresVectorStore.searchMany` に、クエリごとの `search` を並べたものと同じ入力を流し、戻り値を突き合わせる
 * （Postgres の内側の差分の歯。2実装を並べる `store-boundary-diff.postgres.test.ts` と同じ形）。
 *
 * 契約（`VectorStore.searchMany?` の TSDoc）: 各 `queries[i]` の結果は、同じ `opts` で `search` を単独で呼んだ
 * 場合と、集合・順序ともに完全に一致する。返す `Map` の key は `queries` の key と同じ集合。
 *
 * - 比べるもの: `searchMany` の `Map` の並び（key と、その key の結果）と、`queries` の順に `search` を呼んだ
 *   並び（key と、その結果か「投げた」）。結果は memoryId を別名に伏せ、距離を含めて比べる。
 *   `searchMany` が投げたときは、全部の key を「投げた」として並べる。
 * - 当てるのは、`VectorFilter` の各欄・`limit` の境界・比較不能のクエリ・key の境界（下の `scenarios`）。
 *   ベクトルの成分は整数にしてある（float4 の丸めは #1268 の範囲）。
 *
 * 🔴 **許可リスト（`KNOWN_DIFFERENCES`）は、契約の外で、揃える先が未決の Issue に在る差だけを持つ**（key の重複は
 * Issue #1284。今の振る舞いは `searchMany?` の TSDoc に書いてある。例外の有無の差（Issue #1285、NUL を含む key）は
 * 直したので載せていない——`search` が投げない入力では `searchMany` も投げない）。
 * 各項目は今の振る舞い（`search` 側と `searchMany` 側の戻り値の形）を持ち、実測と違えば落ちる。
 * 許可リストの外で差が出たら落ちる（契約に反する差は `searchMany` を直す）。差が出なくなったら、それも落ちる。
 */

type Kind = "throws" | "returns";

interface KnownDifference {
  /** 揃える先が未決の Issue。 */
  issue: string;
  /** クエリごとの `search` の形（どれか1つでも投げたら `throws`）。 */
  search: Kind;
  searchMany: Kind;
  /**
   * key の重複の場面だけ: `searchMany` が返した `Map` の key の数、`queries` の長さ、その1つの key に
   * 積まれた件数が `search` の結果の件数の和と同じか。
   */
  keys?: { searchMany: number; queries: number; hitsAreSumOfSearch: boolean };
}

const DUPLICATE_KEY = "https://github.com/takecchi/mnemora/issues/1284";

const KNOWN_DIFFERENCES: Readonly<Record<string, KnownDifference>> = {
  "queries:同じ key・同じベクトルを2回": {
    issue: DUPLICATE_KEY,
    search: "returns",
    searchMany: "returns",
    keys: { searchMany: 1, queries: 2, hitsAreSumOfSearch: true },
  },
  "queries:同じ key・違うベクトル": {
    issue: DUPLICATE_KEY,
    search: "returns",
    searchMany: "returns",
    keys: { searchMany: 1, queries: 2, hitsAreSumOfSearch: true },
  },
};

const SPACE = TEST_EMBEDDING_SPACE;
const runTag = Math.random().toString(36).slice(2, 7);
const ctx: Ctx = { tenantId: `smd-${runTag}` };
const other: Ctx = { tenantId: `smd-other-${runTag}` };

const alias = new Map<string, string>();

type Query = { key: string; vector: number[] };
type Opts = { limit: number; filter: VectorFilter };

const Q: Query[] = [
  { key: "x", vector: [1, 0, 0] },
  { key: "y", vector: [0, 1, 0] },
  { key: "xyz", vector: [1, 1, 1] },
  { key: "-x", vector: [-1, 0, 0] },
];

function filter(extra: Partial<VectorFilter> = {}): VectorFilter {
  return { tenantId: ctx.tenantId, ...extra };
}

function hits(list: VectorHit[]): Array<[string, number]> {
  return list.map((h) => [alias.get(h.memoryId) ?? `<${h.memoryId}>`, h.distance]);
}

interface Outcome {
  /** `[key, 結果]` の並び。 */
  entries: Array<[string, Array<[string, number]> | "投げた"]>;
  kind: Kind;
}

async function runSearchMany(
  vs: PostgresVectorStore,
  queries: Query[],
  opts: Opts,
  c: Ctx,
): Promise<Outcome> {
  try {
    const map = await vs.searchMany(c, SPACE, queries, opts);
    return { entries: [...map].map(([k, v]) => [k, hits(v)]), kind: "returns" };
  } catch {
    return { entries: queries.map((q) => [q.key, "投げた"]), kind: "throws" };
  }
}

async function runSearchEach(
  vs: PostgresVectorStore,
  queries: Query[],
  opts: Opts,
  c: Ctx,
): Promise<Outcome> {
  const entries: Outcome["entries"] = [];
  let kind: Kind = "returns";
  for (const q of queries) {
    try {
      entries.push([q.key, hits(await vs.search(c, SPACE, q.vector, opts))]);
    } catch {
      entries.push([q.key, "投げた"]);
      kind = "throws";
    }
  }
  return { entries, kind };
}

interface Scenario {
  queries: Query[];
  opts: Opts;
  ctx?: Ctx;
}
const scenarios: Array<[string, () => Scenario]> = [];
const add = (name: string, s: () => Scenario) => scenarios.push([name, s]);
const withFilter = (name: string, extra: Partial<VectorFilter>) =>
  add(`filter.${name}`, () => ({ queries: Q, opts: { limit: 10, filter: filter(extra) } }));

// ---- filter の各欄 ----
withFilter("tenantId だけ", {});
withFilter("status:[active]", { status: ["active"] });
withFilter("status:[archived]", { status: ["archived"] });
withFilter("status:[]", { status: [] });
withFilter("decayFloorAtAfter", { decayFloorAtAfter: new Date("2026-02-01T00:00:00.000Z") });
withFilter("subjectId:s1", { subjectId: "s1" });
withFilter("subjectId:s1+includeSubjectless", { subjectId: "s1", includeSubjectless: true });
withFilter("includeSubjectless だけ", { includeSubjectless: true });
withFilter("excludeProvenanceKinds:[consolidated]", { excludeProvenanceKinds: ["consolidated"] });
withFilter("excludeProvenanceKinds:[]", { excludeProvenanceKinds: [] });
withFilter("occurredAfter", { occurredAfter: new Date("2026-01-05T00:00:00.000Z") });
withFilter("occurredBefore", { occurredBefore: new Date("2026-01-05T00:00:00.000Z") });
withFilter("occurredAfter>occurredBefore", {
  occurredAfter: new Date("2026-01-20T00:00:00.000Z"),
  occurredBefore: new Date("2026-01-05T00:00:00.000Z"),
});
withFilter("decayFloorSeqAfter:3", { decayFloorSeqAfter: 3 });
withFilter("decayFloorAnyAxis", {
  decayFloorAtAfter: new Date("2026-02-01T00:00:00.000Z"),
  decayFloorSeqAfter: 3,
  decayFloorAnyAxis: true,
});
withFilter("validAt", { validAt: new Date("2026-01-15T00:00:00.000Z") });
withFilter("attributes:{team:x}", { attributes: { team: "x" } });
withFilter("attributes:{}", { attributes: {} });
withFilter("labels:[a]", { labels: ["a"] });
withFilter("labels:[a,b]", { labels: ["a", "b"] });
withFilter("labels:[]", { labels: [] });
withFilter("tenantId:other（ctx と食い違う）", { tenantId: other.tenantId });
for (const field of ["decayFloorAtAfter", "occurredAfter", "occurredBefore", "validAt"] as const) {
  withFilter(`${field}:Invalid Date`, { [field]: new Date(Number.NaN) });
}
withFilter("decayFloorSeqAfter:1.5", { decayFloorSeqAfter: 1.5 });

// ---- limit ----
for (const limit of [0, 1, 2, 100, -1, 1.5, Number.NaN]) {
  add(`limit:${limit}`, () => ({ queries: Q, opts: { limit, filter: filter() } }));
}

// ---- クエリ ----
const one = (queries: Query[]) => () => ({ queries, opts: { limit: 10, filter: filter() } });
add("queries:[]", one([]));
add("queries:1件", one([Q[0]!]));
add("queries:同じベクトルを別の key で2回", one([Q[0]!, { key: "x2", vector: [1, 0, 0] }]));
add("queries:同じ key・同じベクトルを2回", one([Q[0]!, Q[0]!]));
add("queries:同じ key・違うベクトル", one([Q[0]!, { key: "x", vector: [0, 1, 0] }]));
add("queries:key が空文字", one([{ key: "", vector: [1, 0, 0] }]));
add("queries:key に NUL", one([{ key: "k\u0000", vector: [1, 0, 0] }]));
add("queries:次元違い（比較不能）", one([Q[0]!, { key: "short", vector: [1, 0] }]));
add("queries:空のベクトル（比較不能）", one([Q[0]!, { key: "empty", vector: [] }]));
add("queries:NaN（比較不能）", one([Q[0]!, { key: "nan", vector: [Number.NaN, 0, 0] }]));
add(
  "queries:Infinity（比較不能）",
  one([{ key: "inf", vector: [Number.POSITIVE_INFINITY, 0, 0] }]),
);
add("queries:ゼロベクトル（比較不能）", one([Q[0]!, { key: "zero", vector: [0, 0, 0] }]));
add(
  "queries:20件",
  one(
    Array.from({ length: 20 }, (_, i) => ({
      key: `q${i}`,
      vector: [(i % 3) - 1, ((i >> 1) % 3) - 1, ((i >> 2) % 3) - 1],
    })),
  ),
);

const differing = new Map<string, { single: Outcome; many: Outcome; queries: number }>();
const observedSingle = new Map<string, Outcome>();

describe("PostgresVectorStore.searchMany は、クエリごとの search を並べたものと同じ結果を返す", () => {
  beforeAll(async () => {
    const { db } = await getTestClient();
    const ms = new PostgresMemoryStore(db);
    const vs = new PostgresVectorStore(db);
    const put = async (name: string, vector: number[], over: Partial<NewMemory>, c = ctx) => {
      const m = await ms.createMemory(
        c,
        buildNewMemoryFixture({ tenantId: c.tenantId, contentHash: name, ...over }),
      );
      await vs.upsert(c, SPACE, m.id, vector);
      alias.set(m.id as MemoryId, name);
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
    await put("m4", [1, 1, 0], { provenance: buildProvenanceFixture("consolidated") });
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

    for (const [name, build] of scenarios) {
      const s = build();
      const c = s.ctx ?? ctx;
      const single = await runSearchEach(vs, s.queries, s.opts, c);
      const many = await runSearchMany(vs, s.queries, s.opts, c);
      observedSingle.set(name, single);
      if (JSON.stringify(single.entries) !== JSON.stringify(many.entries)) {
        differing.set(name, { single, many, queries: s.queries.length });
      }
    }
  }, 240_000);

  afterAll(async () => {
    await closeTestClient();
  });

  it("場面の名前は重複しない（許可リストが名前で引くため）", () => {
    expect(new Set(scenarios.map(([name]) => name)).size).toBe(scenarios.length);
  });

  it("🔴 許可リストの外で、searchMany と search の並びに差が出ない", () => {
    const unexpected = [...differing]
      .filter(([name]) => !(name in KNOWN_DIFFERENCES))
      .map(([name, { single, many }]) =>
        [
          `- ${name}`,
          `    search を並べたもの: ${JSON.stringify(single.entries).slice(0, 400)}`,
          `    searchMany:          ${JSON.stringify(many.entries).slice(0, 400)}`,
        ].join("\n"),
      );
    expect(
      unexpected,
      `許可リストの外で、${unexpected.length} 件の場面に差が出た。契約（searchMany の TSDoc）に反するなら ` +
        `searchMany を直し、契約の外なら Issue に書いてから KNOWN_DIFFERENCES に足すこと:\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("🔴 許可リストの場面は、今も書いた形で違う（揃ったのにリストに残っていたら、リストが古い）", () => {
    const stale = Object.keys(KNOWN_DIFFERENCES).filter((name) => !differing.has(name));
    const unknown = Object.keys(KNOWN_DIFFERENCES).filter(
      (name) => !scenarios.some(([scenario]) => scenario === name),
    );
    const mismatched = [...differing]
      .filter(([name]) => name in KNOWN_DIFFERENCES)
      .map(([name, { single, many, queries }]) => {
        const { issue: _issue, ...expected } = KNOWN_DIFFERENCES[name]!;
        const observed = {
          search: single.kind,
          searchMany: many.kind,
          ...(expected.keys
            ? {
                keys: {
                  searchMany: many.entries.length,
                  queries,
                  hitsAreSumOfSearch:
                    many.entries.flatMap(([, r]) => (r === "投げた" ? [] : r)).length ===
                    single.entries.flatMap(([, r]) => (r === "投げた" ? [] : r)).length,
                },
              }
            : {}),
        };
        return { name, expected, observed };
      })
      .filter(({ expected, observed }) => JSON.stringify(expected) !== JSON.stringify(observed));
    expect(
      { stale, unknown, mismatched },
      `許可リストが古いか、今の振る舞いと違う: ${JSON.stringify({ stale, unknown, mismatched }, null, 2)}`,
    ).toEqual({ stale: [], unknown: [], mismatched: [] });
  });

  it("検算: 同点・比較不能・絞り込み・例外が実際に起きている（この歯が何も比べていない、にならないため）", () => {
    const got = (name: string) => observedSingle.get(name)!;
    const ids = (name: string, key = "x") => {
      const r = got(name).entries.find(([k]) => k === key)![1];
      return r === "投げた" ? r : r.map(([id]) => id);
    };
    // 同点（m1 と m2 は同じベクトル。recorded_at DESC で m2 が先）と、比較不能（ゼロベクトルの m8 は距離が NaN）。
    expect(got("filter.tenantId だけ").entries[0]![1]).toEqual(
      expect.arrayContaining([
        ["m2", 0],
        ["m1", 0],
        ["m8", Number.NaN],
      ]),
    );
    expect(ids("filter.tenantId だけ").slice(0, 2)).toEqual(["m2", "m1"]);
    // 絞り込みが効いている（件数が減る）。他テナントの o1 は出ない。
    expect(ids("filter.status:[archived]")).toEqual(["m3"]);
    expect(ids("filter.labels:[a]")).toEqual(["m1"]);
    expect(ids("filter.tenantId だけ")).not.toContain("o1");
    expect(ids("limit:2")).toHaveLength(2);
    // 両方が投げる場面も在る（例外の有無の一致を比べている）。
    expect(got("limit:-1").kind).toBe("throws");
    expect(got("filter.validAt:Invalid Date").kind).toBe("throws");
  });
});
