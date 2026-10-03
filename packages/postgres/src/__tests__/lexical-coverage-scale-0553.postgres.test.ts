import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, LexicalHit, LexicalStore, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryLexicalStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD,
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `lexicalMatch`（= `LexicalStore` が返す `coverage`）の尺度を、3つの store を同じ入力で当てて縛る
 * （[ADR 0553](../../../../docs/decisions/0553-lexical-coverage-scale-across-stores.md)。ADR 0484 の負債1）。
 *
 * 対象: testkit の `InMemoryLexicalStore`・`PostgresLexicalStore`（tsvector）・
 * `PostgresTrigramLexicalStore`（pg_trgm）。core の `FakeLexicalStore` は InMemory と同じ式なので測らない。
 *
 * **固定するのは2種類だけである。**
 * - 式から決まる値: tsvector と InMemory の「一致した語数 ÷ 語の総数」（1/n 刻み）、
 *   trigram の日本語側の 0/1、閾値の前後での 0 と 1 の入れ替わり。
 * - 性質: 当たる語が増えれば coverage は減らない、返り値は `(coverage DESC, rank DESC)` の順、
 *   同点が出る所（単語1つのクエリ、日本語側）。
 *
 * **固定しないもの: `rank`・`word_similarity` の実数。**Postgres・pg_trgm の版で揺れうる。
 * その値は ADR 0553 の表に「測った値」として残してある。閾値の前後の入力は、`word_similarity` が
 * 閾値から {@link MARGIN} 以上離れる文面を選んであり、その前提は下の「前提検査」の it が測る
 * （揺れて前提が崩れたとき、coverage の食い違いより先にここが赤くなる）。
 *
 * SQL_ASCII の leg では `PostgresTrigramLexicalStore.create` が拒むので（ADR 0319）、trigram の組では
 * `create()` の拒否だけを確かめ、検索は飛ばす。
 */

const ctx: Ctx = { tenantId: "lexical-coverage-scale-0553" };
const filter = { tenantId: ctx.tenantId };

/** `word_similarity` と閾値の間に取る余白。揺れで歯が割れないための値。 */
const MARGIN = 0.15;
/** 日本語側の「当たる／当たらない」を分けるために、既定の 0.3 の上下に置く閾値。 */
const LOW = 0.15;
const HIGH = 0.85;

afterAll(async () => {
  await closeTestClient();
});

type Kind = "inmemory" | "tsvector" | "trigram";
const KINDS: Kind[] = ["inmemory", "tsvector", "trigram"];

interface Kit {
  memoryStore: MemoryStore;
  lexicalStore: LexicalStore;
}

/** `null` は、この環境ではその組を当てられない（trigram が SQL_ASCII で拒まれた）ことを表す。 */
async function makeKit(kind: Kind, threshold?: number): Promise<Kit | null> {
  if (kind === "inmemory") {
    const memoryStore = new InMemoryMemoryStore();
    return { memoryStore, lexicalStore: new InMemoryLexicalStore(memoryStore) };
  }
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  if (kind === "tsvector") {
    return { memoryStore, lexicalStore: new PostgresLexicalStore(db) };
  }
  const probe = await probeTrigramLexicalSupport(db);
  if (!probe.ok) {
    await expect(PostgresTrigramLexicalStore.create(db)).rejects.toThrow();
    return null;
  }
  const opts = threshold === undefined ? undefined : { threshold };
  return { memoryStore, lexicalStore: await PostgresTrigramLexicalStore.create(db, opts) };
}

interface Row {
  content: string;
  coverage: number;
  rank: number;
}

/** `contents` を1件ずつ（recordedAt は増える向き）入れ、id → content の対応を返す。 */
async function populate(kit: Kit, contents: string[]): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  let i = 0;
  for (const content of contents) {
    const memory = await kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content,
        contentHash: content,
        recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i++)),
      }),
    );
    byId.set(memory.id, content);
  }
  return byId;
}

/** 入れ済みの記憶に `query` を当て、content つきの行で返す。順序と値域の性質もここで見る。 */
async function searchRows(kit: Kit, byId: Map<string, string>, query: string): Promise<Row[]> {
  const hits: LexicalHit[] = await kit.lexicalStore.search(ctx, query, { limit: 50, filter });
  const rows = hits.map((h) => ({
    content: byId.get(h.memoryId)!,
    coverage: h.coverage,
    rank: h.rank,
  }));
  // 性質: 返り値は coverage 降順、同じ coverage の中では rank 降順（値は見ない）。
  for (let k = 1; k < rows.length; k++) {
    const prev = rows[k - 1]!;
    const cur = rows[k]!;
    expect(prev.coverage).toBeGreaterThanOrEqual(cur.coverage);
    if (prev.coverage === cur.coverage) {
      expect(prev.rank).toBeGreaterThanOrEqual(cur.rank);
    }
  }
  // 値域 (0, 1]
  for (const r of rows) {
    expect(r.coverage).toBeGreaterThan(0);
    expect(r.coverage).toBeLessThanOrEqual(1);
  }
  return rows;
}

async function run(kit: Kit, contents: string[], query: string): Promise<Row[]> {
  return searchRows(kit, await populate(kit, contents), query);
}

function coverageOf(rows: Row[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.content, r.coverage]));
}

function expectCoverage(rows: Row[], expected: Record<string, number>): void {
  const got = coverageOf(rows);
  expect(Object.keys(got).sort()).toEqual(Object.keys(expected).sort());
  for (const [content, c] of Object.entries(expected)) {
    expect(got[content]).toBeCloseTo(c, 12);
  }
}

const TERMS = ["alpha", "beta", "gamma", "delta"];
/** TERMS の空でない部分集合すべて（15 件）。 */
const SUBSET_DOCS: string[][] = [];
for (let mask = 1; mask < 1 << TERMS.length; mask++) {
  SUBSET_DOCS.push(TERMS.filter((_, b) => (mask & (1 << b)) !== 0));
}

for (const kind of KINDS) {
  describe(`${kind}: ASCII の coverage（一致した語数 ÷ 語の総数）`, () => {
    it("語数 n = 1〜4 のクエリで、本文の語の部分集合ごとに |共通| / n になる（当たる語が増えれば減らない）", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const byId = await populate(kit, [...SUBSET_DOCS.map((s) => s.join(" ")), "zzz"]);
      for (let n = 1; n <= TERMS.length; n++) {
        const rows = await searchRows(kit, byId, TERMS.slice(0, n).join(" "));
        const got = new Map(rows.map((r) => [r.content, r.coverage]));
        const qTerms = new Set(TERMS.slice(0, n));
        const expected = new Map<string, number>();
        for (const s of SUBSET_DOCS) {
          const common = s.filter((t) => qTerms.has(t)).length;
          if (common > 0) expected.set(s.join(" "), common / n);
        }
        expect([...got.keys()].sort()).toEqual([...expected.keys()].sort());
        for (const [content, c] of expected) {
          expect(got.get(content)).toBeCloseTo(c, 12);
        }
        // 単調: 本文の語が増えた（部分集合 → 上位集合）とき coverage は減らない。
        for (const a of SUBSET_DOCS) {
          for (const b of SUBSET_DOCS) {
            if (a.every((t) => b.includes(t)) && got.has(a.join(" "))) {
              expect(got.get(b.join(" "))!).toBeGreaterThanOrEqual(got.get(a.join(" "))!);
            }
          }
        }
      }
    });

    it("3語のクエリ: 2語に当たれば 2/3、1語なら 1/3、全部なら 1", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(
        kit,
        ["alpha beta gamma", "alpha beta", "gamma", "alpha beta gamma delta"],
        "alpha beta gamma",
      );
      expectCoverage(rows, {
        "alpha beta gamma": 1,
        "alpha beta gamma delta": 1,
        "alpha beta": 2 / 3,
        gamma: 1 / 3,
      });
      // 3 語中 2 語は、ちょうど 2/3（0.5 でも 1 でもない）。
      expect(coverageOf(rows)["alpha beta"]).toBe(2 / 3);
    });

    it("4語のクエリ: 3語に当たれば 3/4、2語なら 1/2、1語なら 1/4", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(
        kit,
        ["alpha beta gamma delta", "alpha beta gamma", "alpha beta", "delta"],
        "alpha beta gamma delta",
      );
      expectCoverage(rows, {
        "alpha beta gamma delta": 1,
        "alpha beta gamma": 3 / 4,
        "alpha beta": 1 / 2,
        delta: 1 / 4,
      });
    });

    it("語が1つのクエリでは、本文の長さ・回数によらず全部が coverage 1 の同点になる", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(
        kit,
        ["alpha", "alpha beta", "alpha beta gamma delta", "alpha alpha alpha alpha"],
        "alpha",
      );
      expectCoverage(rows, {
        alpha: 1,
        "alpha beta": 1,
        "alpha beta gamma delta": 1,
        "alpha alpha alpha alpha": 1,
      });
    });

    it("部分一致は当たらない（cat は category・cats・concatenate に当たらない）", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(kit, ["category", "cats", "concatenate", "cat"], "cat");
      expectCoverage(rows, { cat: 1 });
    });

    it("クエリの同じ語の繰り返しは1語と数える（alpha alpha beta の分母は 2）", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(
        kit,
        ["alpha", "beta", "alpha beta", "alpha alpha alpha alpha alpha alpha"],
        "alpha alpha beta",
      );
      expectCoverage(rows, {
        alpha: 1 / 2,
        beta: 1 / 2,
        "alpha beta": 1,
        "alpha alpha alpha alpha alpha alpha": 1 / 2,
      });
      // coverage が rank より先に効く: 繰り返しの多い 1/2 の本文が、1 の本文を追い越さない。
      expect(rows[0]!.content).toBe("alpha beta");
    });

    it("本文の繰り返しは coverage に効かない（alpha を1語だけ当てる本文は、何回含んでも 1/2）", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(kit, ["alpha", "alpha alpha alpha"], "alpha beta");
      expectCoverage(rows, { alpha: 1 / 2, "alpha alpha alpha": 1 / 2 });
    });

    it("大文字小文字は区別しない", async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(kit, ["alpha", "ALPHA Beta", "Alpha"], "ALPHA beta");
      expectCoverage(rows, { alpha: 1 / 2, "ALPHA Beta": 1, Alpha: 1 / 2 });
    });
  });
}

describe("日本語: tsvector と InMemory は引けない、trigram は引ける", () => {
  for (const kind of ["inmemory", "tsvector"] as const) {
    it(`${kind}: 日本語だけのクエリは1件も返さない`, async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(kit, ["東京タワーに行った", "東京", "大阪城を見た"], "東京");
      expect(rows).toEqual([]);
    });

    it(`${kind}: ASCII と日本語の混ざったクエリでは、日本語の部分が分母にも分子にも入らない`, async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      // 日本語を落とした "alpha" の1語として数える: alpha を含めば 1。
      const rows = await run(kit, ["alpha", "東京タワー", "alpha 東京タワー"], "alpha 東京");
      expectCoverage(rows, { alpha: 1, "alpha 東京タワー": 1 });
    });

    it(`${kind}: 日本語の部分は分母に入らない（alpha beta gamma 東京 の分母は 3）`, async () => {
      const kit = await makeKit(kind);
      if (kit === null) return;
      const rows = await run(kit, ["alpha", "alpha 東京タワー"], "alpha beta gamma 東京");
      expectCoverage(rows, { alpha: 1 / 3, "alpha 東京タワー": 1 / 3 });
    });
  }
});

describe("trigram: 日本語側の coverage は閾値で決まる 0/1 の二値", () => {
  it("前提検査: 使う文面の word_similarity は、使う閾値から MARGIN 以上離れている", async () => {
    const kit = await makeKit("trigram");
    if (kit === null) return;
    const { db } = await getTestClient();
    const ws = async (term: string, content: string): Promise<number> =>
      Number(
        (
          (await db.execute(sql`SELECT word_similarity(${term}, ${content}) AS v`)).rows[0] as {
            v: string;
          }
        ).v,
      );
    const THRESHOLDS = [LOW, DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD, HIGH];
    const probes: Array<[string, string]> = [
      ["東京", "東京タワーに行った"],
      ["東京", "alpha 東京タワー"],
      ["東京 大阪", "東京"],
    ];
    for (const [term, content] of probes) {
      const v = await ws(term, content);
      for (const t of THRESHOLDS) {
        expect(
          Math.abs(v - t),
          `word_similarity(${term}, ${content}) = ${v}, threshold ${t}`,
        ).toBeGreaterThan(MARGIN);
      }
    }
    // 大阪城を見た は「東京」に 0（閾値の遥か下）。
    expect(await ws("東京", "大阪城を見た")).toBeLessThan(0.15);
    // 同じ文字列どうしは ちょうど 1（上の閾値 HIGH より MARGIN 以上上）。
    expect(await ws("東京", "東京")).toBeGreaterThanOrEqual(HIGH + MARGIN);
  });

  it("閾値を超えた本文は、word_similarity の大小によらず coverage 1（同点）。閾値の下は返らない", async () => {
    const kit = await makeKit("trigram");
    if (kit === null) return;
    const rows = await run(kit, ["東京タワーに行った", "東京", "大阪城を見た"], "東京");
    // 東京 は word_similarity が 1、東京タワーに行った は中間。どちらも coverage は同じ 1。
    expectCoverage(rows, { 東京: 1, 東京タワーに行った: 1 });
  });

  it("閾値を上げると、中間の本文は返らなくなり、同じ文字列だけが 1 で残る", async () => {
    const kit = await makeKit("trigram", HIGH);
    if (kit === null) return;
    const rows = await run(kit, ["東京タワーに行った", "東京", "大阪城を見た"], "東京");
    expectCoverage(rows, { 東京: 1 });
  });

  it("閾値を下げても coverage は 1 のまま（word_similarity は coverage に入らない）", async () => {
    const kit = await makeKit("trigram", LOW);
    if (kit === null) return;
    const rows = await run(kit, ["東京タワーに行った", "東京", "大阪城を見た"], "東京");
    expectCoverage(rows, { 東京: 1, 東京タワーに行った: 1 });
  });

  it("日本語の複数語は語ごとに数えない（東京 大阪 に東京だけの本文が 1/2 ではなく 1）", async () => {
    const low = await makeKit("trigram", LOW);
    if (low === null) return;
    const rowsLow = await run(low, ["東京", "東京 大阪"], "東京 大阪");
    expectCoverage(rowsLow, { 東京: 1, "東京 大阪": 1 });
    const high = await makeKit("trigram", HIGH);
    if (high === null) return;
    const rowsHigh = await run(high, ["東京", "東京 大阪"], "東京 大阪");
    expectCoverage(rowsHigh, { "東京 大阪": 1 });
  });

  it("閾値がちょうど 1 でも、同じ文字列は coverage 1（比較は >= であり、0 にならない）", async () => {
    const kit = await makeKit("trigram", 1);
    if (kit === null) return;
    const rows = await run(kit, ["東京", "東京タワーに行った"], "東京");
    expectCoverage(rows, { 東京: 1 });
  });

  it("閾値が 0.9 と 1 の間でも、その値で切る（0.9 で頭打ちにしない）", async () => {
    // 0.9〜1 の間の閾値を縛る歯（ADR 0589 の TR2）。上の HIGH（0.85）と 1 の歯だけでは、
    // 閾値を 0.9 で頭打ちにしても通っていた。
    const BAND = 0.97;
    // 漢字だけの 15 文字。末尾に1文字足した本文の word_similarity は 15/16（PostgreSQL 17 で 0.9375）。
    const term = "北海道札幌市中央区大通西四丁目";
    const near = `${term}一`;
    const mixedNear = `alpha ${near}`;
    const kit = await makeKit("trigram", BAND);
    if (kit === null) return;
    const { db } = await getTestClient();
    // 前提検査: near の word_similarity は 0.9 と BAND の間にあり、両側から余白をとって離れている。
    const v = Number(
      (
        (await db.execute(sql`SELECT word_similarity(${term}, ${mixedNear}) AS v`)).rows[0] as {
          v: string;
        }
      ).v,
    );
    expect(v, `word_similarity = ${v}`).toBeGreaterThan(0.9 + 0.02);
    expect(v, `word_similarity = ${v}`).toBeLessThan(BAND - 0.02);
    const rows = await run(kit, [term, near, mixedNear], `alpha beta gamma ${term}`);
    // near は日本語側が閾値の下なので返らない。mixedNear は ASCII 側の 1/3 で返る（日本語側の 1 にならない）。
    expectCoverage(rows, { [term]: 1, [mixedNear]: 1 / 3 });
  });

  const MIXED_QUERY = "alpha beta gamma 東京";
  const MIXED_DOCS = ["alpha beta gamma", "alpha 東京タワー", "alpha", "東京"];

  it("ASCII と日本語の混在: 日本語側が閾値の上なら 1、下なら ASCII 側の 1/3 に戻る（入れ替わる点）", async () => {
    const low = await makeKit("trigram");
    if (low === null) return;
    const rowsDefault = await run(low, MIXED_DOCS, MIXED_QUERY);
    expectCoverage(rowsDefault, {
      "alpha beta gamma": 1,
      "alpha 東京タワー": 1,
      alpha: 1 / 3,
      東京: 1,
    });
    // coverage 1 の3件が、1/3 の alpha より先に並ぶ。
    expect(
      rowsDefault
        .slice(0, 3)
        .map((r) => r.content)
        .sort(),
    ).toEqual(["alpha beta gamma", "alpha 東京タワー", "東京"].sort());

    const high = await makeKit("trigram", HIGH);
    if (high === null) return;
    const rowsHigh = await run(high, MIXED_DOCS, MIXED_QUERY);
    expectCoverage(rowsHigh, {
      "alpha beta gamma": 1,
      "alpha 東京タワー": 1 / 3,
      alpha: 1 / 3,
      東京: 1,
    });
    expect(
      rowsHigh
        .slice(0, 2)
        .map((r) => r.content)
        .sort(),
    ).toEqual(["alpha beta gamma", "東京"].sort());
  });

  it("日本語側が当たれば、ASCII の語数の多さにかかわらず coverage は 1（tsvector・InMemory では 1/3）", async () => {
    const kinds: Array<[Kind, number]> = [
      ["trigram", 1],
      ["tsvector", 1 / 3],
      ["inmemory", 1 / 3],
    ];
    for (const [kind, expected] of kinds) {
      const kit = await makeKit(kind);
      if (kit === null) continue;
      const rows = await run(kit, ["alpha 東京タワー"], MIXED_QUERY);
      expectCoverage(rows, { "alpha 東京タワー": expected });
    }
  });
});
