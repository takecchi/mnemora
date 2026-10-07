import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemory, VectorFilter, VectorHit } from "@mnemora/core";
import { buildNewMemoryFixture, buildProvenanceFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { closeTestClient, getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * `PostgresVectorStore.searchMany` に、クエリごとの `search` を並べたものと同じ入力を流し、戻り値を突き合わせる
 * （Postgres の内側の差分の歯）。
 *
 * 契約（`VectorStore.searchMany?` の TSDoc）: 各 `queries[i]` の結果は、同じ `opts` で `search` を単独で呼んだ
 * 場合と、集合・順序ともに完全に一致する。返す `Map` の key は `queries` の key と同じ集合。
 * 同じ key が2回以上あるときは、**最後のクエリの結果だけ**を返し、`Map` の並びはその key が**最初に現れた位置**
 * である——結果は `new Map(queries.map((q) => [q.key, search(q)]))` と同じ。ただし、同じ key のうち
 * 前のクエリだけが投げる入力（そのベクトルだけが DB に拒まれる値）では、この式は投げるが、`searchMany` は投げずに
 * 返す（前のクエリは SQL に送らないため）。この歯の場面には、その入力は無い。
 *
 * - 比べるもの: `searchMany` の `Map` の並び（key と、その key の結果）と、`queries` の順に `search` を呼び、
 *   上の `new Map(…)` と同じく畳んだ並び（key と、その結果か「投げた」）。結果は memoryId を別名に伏せ、
 *   距離を含めて比べる。`searchMany` が投げたときは、全部の key を「投げた」として並べる。
 * - 当てるのは、`VectorFilter` の各欄・`limit` の境界・比較不能のクエリ・key の境界（下の `scenarios`）。
 *   ベクトルの成分は整数にしてある（float4 の丸めは `vector-search-float4-tie.postgres.test.ts` が見る）。
 *
 * 🔴 **許可リスト（`KNOWN_DIFFERENCES`）は、契約の外で、揃える先が未決の Issue に在る差だけを持つ**（今は空）。
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
}

const KNOWN_DIFFERENCES: Readonly<Record<string, KnownDifference>> = {};

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

/** `new Map(entries)` と同じく畳む: 同じ key は最初に現れた位置に、最後の値を置く。 */
function foldLikeMap(outcome: Outcome): Outcome {
  return { ...outcome, entries: [...new Map(outcome.entries)] };
}

const hasDuplicateKey = (queries: Query[]) =>
  new Set(queries.map((q) => q.key)).size !== queries.length;

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

for (const limit of [0, 1, 2, 100, -1, 1.5, Number.NaN]) {
  add(`limit:${limit}`, () => ({ queries: Q, opts: { limit, filter: filter() } }));
}

const one = (queries: Query[]) => () => ({ queries, opts: { limit: 10, filter: filter() } });
add("queries:[]", one([]));
add("queries:1件", one([Q[0]!]));
add("queries:同じベクトルを別の key で2回", one([Q[0]!, { key: "x2", vector: [1, 0, 0] }]));
add("queries:同じ key・同じベクトルを2回", one([Q[0]!, Q[0]!]));
add("queries:同じ key・違うベクトル", one([Q[0]!, { key: "x", vector: [0, 1, 0] }]));
// 並びを縛る: key "x" は最初の位置（先頭）に、最後のベクトル（[1,0,1]）の結果で現れる。"y" はその後。
add(
  "queries:同じ key が離れて3回（間に別の key）",
  one([Q[0]!, Q[1]!, { key: "x", vector: [0, 0, 1] }, { key: "x", vector: [1, 0, 1] }]),
);
// 返る Map の key は入力と一字一句同じ（空白・Unicode の正規化・大文字小文字で、key を加工も統合もしない）。
// key ごとにベクトルを変えてあるので、結果が混ざれば（key の取り違え・統合）並びか中身に出る。
const KEY_EXACTNESS: Record<string, Query[]> = {
  "queries:key の前後に空白": [
    { key: " x ", vector: [1, 0, 0] },
    { key: "x", vector: [0, 1, 0] },
    { key: "\ty\n", vector: [0, 0, 1] },
  ],
  "queries:key が合成済みの é と分解形の é": [
    { key: "é", vector: [1, 0, 0] },
    { key: "é", vector: [0, 1, 0] },
  ],
  "queries:key が大文字小文字だけ違う": [
    { key: "Key", vector: [1, 0, 0] },
    { key: "key", vector: [0, 1, 0] },
    { key: "KEY", vector: [0, 0, 1] },
  ],
};
for (const [name, queries] of Object.entries(KEY_EXACTNESS)) add(name, one(queries));
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

const differing = new Map<string, { single: Outcome; many: Outcome }>();
const observedSingle = new Map<string, Outcome>();
/** key が重複しない場面の、畳む前の `search` の並びと `searchMany` の並び（過剰実装の歯が使う）。 */
const uniqueKeyRuns = new Map<string, { raw: Outcome; many: Outcome }>();
/** 最後の値を採ったか・並びを最初の位置にしたかを、名指しで見る場面。 */
const duplicateKeyRuns = new Map<string, { raw: Outcome; many: Outcome; opts: Opts }>();

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
      const raw = await runSearchEach(vs, s.queries, s.opts, c);
      const single = foldLikeMap(raw);
      const many = await runSearchMany(vs, s.queries, s.opts, c);
      observedSingle.set(name, single);
      if (hasDuplicateKey(s.queries)) {
        duplicateKeyRuns.set(name, { raw, many, opts: s.opts });
      } else {
        uniqueKeyRuns.set(name, { raw, many });
      }
      if (JSON.stringify(single.entries) !== JSON.stringify(many.entries)) {
        differing.set(name, { single, many });
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
      .map(([name, { single, many }]) => {
        const { issue: _issue, ...expected } = KNOWN_DIFFERENCES[name]!;
        const observed = { search: single.kind, searchMany: many.kind };
        return { name, expected, observed };
      })
      .filter(({ expected, observed }) => JSON.stringify(expected) !== JSON.stringify(observed));
    expect(
      { stale, unknown, mismatched },
      `許可リストが古いか、今の振る舞いと違う: ${JSON.stringify({ stale, unknown, mismatched }, null, 2)}`,
    ).toEqual({ stale: [], unknown: [], mismatched: [] });
  });

  it("🔴 同じ key が2回以上あると、最後のクエリの結果だけを、その key が最初に現れた位置に返す（Issue #1284）", () => {
    expect(duplicateKeyRuns.size).toBeGreaterThanOrEqual(3);
    for (const [name, { raw, many, opts }] of duplicateKeyRuns) {
      const firstPositions = [...new Set(raw.entries.map(([k]) => k))];
      const lastValue = (key: string) => raw.entries.filter(([k]) => k === key).at(-1)![1];
      expect(
        many.entries.map(([k]) => k),
        `${name}: 並びは最初に現れた位置`,
      ).toEqual(firstPositions);
      for (const [key, result] of many.entries) {
        expect(result, `${name}: key ${key} は最後のクエリの結果`).toEqual(lastValue(key));
        // 結果を積まない（`search` と同じく limit を超えない）。
        if (result !== "投げた") expect(result.length).toBeLessThanOrEqual(opts.limit);
      }
    }
  });

  it("過剰実装の歯: key が重複しない場面では、searchMany は畳む前の search の並びと完全に一致する", () => {
    // key が重複しなければ畳んでも変わらないので、ここは `foldLikeMap` を通さずに比べる
    // （後勝ちの処理が、重複の無い入力の結果や並びまで変えていないこと）。
    expect(uniqueKeyRuns.size).toBeGreaterThan(40);
    const changed = [...uniqueKeyRuns]
      .filter(([, { raw, many }]) => JSON.stringify(raw.entries) !== JSON.stringify(many.entries))
      .map(([name]) => name);
    expect(changed).toEqual([]);
  });

  it("🔴 返る Map の key は入力と一字一句同じで、key ごとの結果は混ざらない（#1299 M8）", () => {
    for (const [name, queries] of Object.entries(KEY_EXACTNESS)) {
      const run = uniqueKeyRuns.get(name)!;
      expect(
        run.many.entries.map(([k]) => k),
        `${name}: key は入力のまま、同じ並び`,
      ).toEqual(queries.map((q) => q.key));
      // key ごとにベクトルが違うので、結果も key ごとに違う（統合・取り違えがあれば減る）。
      expect(new Set(run.many.entries.map(([, v]) => JSON.stringify(v))).size, name).toBe(
        queries.length,
      );
    }
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
