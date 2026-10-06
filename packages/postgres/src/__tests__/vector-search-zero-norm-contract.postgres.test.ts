import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { captureClientQuery, closeTestClient, getTestClient } from "./test-db.js";

/**
 * Issue #956（PR #982）の約束のうち、`vector-search-zero-norm.postgres.test.ts` が見ていない側。
 * 約束: `search()` / `searchMany()` は、ゼロベクトル（norm 0。距離は常に `NaN`）の候補を
 * 返す。**1回ずつ**（重複させない）、**非ゼロの候補の後ろに**、同じ3段のタイブレーク
 * （距離 → `recorded_at` DESC → `memory_id`）で並べ、`limit` で切る（ゼロ候補が `limit` より
 * 多いときは、`recorded_at` の新しいほう・同点なら `memory_id` の小さいほうが残る）。
 * ゼロ候補にも `filter`（status など）と `ctx` / `filter.tenantId` のテナントの境界が掛かる。
 * ADR 0040 の約束（比較できなくても候補は落とさない）と ADR 0343。
 *
 * 統計が無い場面の枝（候補D・`CROSS JOIN LATERAL`）と、統計がある場面の枝（`JOIN memories`）は
 * 別のコードなので、**両方**で同じ期待を見る（どちらの形が使われたかは、発行された SQL で確かめる）。
 *
 * ⚠ 既存の歯は「ゼロの候補が結果に入る」（`toContain`）を見ているが、重複・並び・`limit` での
 * 切れ方・`filter` の掛かり方は見ていない。
 */

const TENANT = `zero-norm-contract-${randomUUID()}`;
const OTHER_TENANT = `zero-norm-contract-other-${randomUUID()}`;
const ctx: Ctx = { tenantId: TENANT };
const otherCtx: Ctx = { tenantId: OTHER_TENANT };

type Mode = "stats-missing" | "stats-present";

describe.each<Mode>(["stats-missing", "stats-present"])(
  "ゼロベクトルの候補の返り方（%s）",
  (mode) => {
    let space: EmbeddingSpaceId;
    let vectorStore: PostgresVectorStore;
    const names = new Map<string, string>();
    const nonZero = { a: "", b: "", c: "" };
    /** recorded_at が同一の4件（memory_id の昇順で返るはず）。 */
    let tiedZeros: string[] = [];
    /** recorded_at が異なる4件（新しい順）。 */
    let datedZerosNewestFirst: string[] = [];
    let archivedZero = "";
    /** subject 付きのゼロ4件（recorded_at は memory_id の昇順に古→新）。 */
    let subjectZerosByIdAsc: string[] = [];
    let otherTenantZero = "";

    beforeAll(async () => {
      const { db, pool } = await getTestClient();
      space = {
        provider: "test-issue-956",
        model: `zero-norm-contract-${mode}-${randomUUID()}`,
        dimensions: 3,
      };
      await registerEmbeddingSpace(pool, space);
      const memoryStore = new PostgresMemoryStore(db);
      vectorStore = new PostgresVectorStore(db);

      const put = async (
        name: string,
        vector: number[],
        over: Parameters<typeof buildNewMemoryFixture>[0] = {},
        c: Ctx = ctx,
      ): Promise<string> => {
        const memory = await memoryStore.createMemory(
          c,
          buildNewMemoryFixture({ tenantId: c.tenantId, contentHash: `${name}-${mode}`, ...over }),
        );
        await vectorStore.upsert(c, space, memory.id, vector);
        names.set(memory.id as MemoryId, name);
        return memory.id;
      };

      nonZero.a = await put("a", [1, 0, 0]);
      nonZero.c = await put("c", [1, 1, 0]);
      nonZero.b = await put("b", [0, 1, 0]);

      const tiedAt = new Date("2026-03-01T00:00:00.000Z");
      for (let i = 0; i < 4; i += 1) {
        tiedZeros.push(
          await put(`tied-${i}`, [0, 0, 0], { recordedAt: tiedAt, subjectId: "tied-subject" }),
        );
      }
      tiedZeros = [...tiedZeros].sort();
      const dated: { id: string; at: number }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const at = new Date(`2026-02-0${i + 1}T00:00:00.000Z`);
        dated.push({
          id: await put(`dated-${i}`, [0, 0, 0], { recordedAt: at }),
          at: at.getTime(),
        });
      }
      datedZerosNewestFirst = dated.sort((x, y) => y.at - x.at).map((d) => d.id);
      for (let i = 0; i < 4; i += 1) {
        subjectZerosByIdAsc.push(await put(`subj-${i}`, [0, 0, 0], { subjectId: "dated-subject" }));
      }
      subjectZerosByIdAsc = [...subjectZerosByIdAsc].sort();
      for (const [i, id] of subjectZerosByIdAsc.entries()) {
        await pool.query("UPDATE memories SET recorded_at = $1 WHERE id = $2", [
          new Date(`2026-01-0${i + 1}T00:00:00.000Z`),
          id,
        ]);
      }
      archivedZero = await put("archived-zero", [0, 0, 0], {
        status: "archived",
        recordedAt: new Date("2026-04-01T00:00:00.000Z"),
      });
      otherTenantZero = await put(
        "other-tenant-zero",
        [0, 0, 0],
        { recordedAt: new Date("2026-05-01T00:00:00.000Z") },
        otherCtx,
      );

      if (mode === "stats-present") {
        await pool.query(`ANALYZE ${embeddingSpaceTableName(space)}`);
        await pool.query("ANALYZE memories");
      }
    }, 120_000);

    afterAll(async () => {
      const { pool } = await getTestClient();
      await pool.query(`DROP TABLE IF EXISTS ${embeddingSpaceTableName(space)}`);
      await closeTestClient();
    });

    /** 新しい `PostgresVectorStore`（統計の確認はインスタンスごと）で search し、使われた SQL の形も確かめる。 */
    async function search(
      c: Ctx,
      query: number[],
      opts: Parameters<PostgresVectorStore["search"]>[3],
    ): Promise<string[]> {
      const { db } = await getTestClient();
      const store = new PostgresVectorStore(db);
      let hits: Awaited<ReturnType<PostgresVectorStore["search"]>> = [];
      const captured = await captureClientQuery(
        (text) => text.includes(embeddingSpaceTableName(space)) && /union all/i.test(text),
        async () => {
          hits = await store.search(c, space, query, opts);
        },
      );
      expect(/cross join lateral/i.test(captured.text)).toBe(mode === "stats-missing");
      return hits.map((h) => h.memoryId);
    }

    async function searchMany(
      c: Ctx,
      queries: { key: string; vector: number[] }[],
      opts: Parameters<PostgresVectorStore["search"]>[3],
    ): Promise<Map<string, string[]>> {
      const { db } = await getTestClient();
      const store = new PostgresVectorStore(db);
      let result = new Map<string, { memoryId: string }[]>();
      const captured = await captureClientQuery(
        (text) => text.includes(embeddingSpaceTableName(space)) && /union all/i.test(text),
        async () => {
          result = await store.searchMany(c, space, queries, opts);
        },
      );
      // searchMany は常に LATERAL で外側から呼ぶが、枝の中の形は統計の有無で変わる。
      expect(
        /memories_pkey|cross join lateral \(\s*select \* from memories/i.test(captured.text),
      ).toBe(mode === "stats-missing");
      return new Map([...result].map(([k, v]) => [k, v.map((h) => h.memoryId)]));
    }

    const filter = { tenantId: TENANT };
    const subjectZerosNewestFirst = () => [...subjectZerosByIdAsc].reverse();

    it("search: 非ゼロの候補は距離順、ゼロの候補はその後ろに recorded_at DESC・memory_id 昇順で、全員が1回ずつ", async () => {
      const ids = await search(ctx, [1, 0, 0], { limit: 50, filter });

      // 非ゼロ: a（距離0）→ c（45度）→ b（直交）。ゼロ: 同日の4件（memory_id 昇順）→ 日付の新しい順。
      // archived のゼロと他テナントのゼロは、filter が無ければ前者は入るので、ここでは status 無しの
      // 呼び出しでは archived のゼロも入る（recorded_at が最も新しいので、ゼロの先頭）。
      expect(ids).toEqual([
        nonZero.a,
        nonZero.c,
        nonZero.b,
        archivedZero,
        ...tiedZeros,
        ...datedZerosNewestFirst,
        ...subjectZerosNewestFirst(),
      ]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("search: ゼロの候補が limit より多いとき、残るのは recorded_at の新しいほう（同点は memory_id の小さいほう）", async () => {
      // status を active に絞る（archived のゼロを除く）。非ゼロ3 + ゼロ上位2。
      const top = await search(ctx, [1, 0, 0], {
        limit: 5,
        filter: { ...filter, status: ["active"] },
      });
      expect(top).toEqual([nonZero.a, nonZero.c, nonZero.b, tiedZeros[0], tiedZeros[1]]);

      // ゼロだけを取りに行く（limit が非ゼロの数以下になる呼び出しでは、非ゼロが先に limit を使い切る）。
      const wide = await search(ctx, [1, 0, 0], {
        limit: 3 + 4 + 1,
        filter: { ...filter, status: ["active"] },
      });
      expect(wide).toEqual([
        nonZero.a,
        nonZero.c,
        nonZero.b,
        ...tiedZeros,
        datedZerosNewestFirst[0],
      ]);
    });

    it("search: ゼロの候補だけに絞ったとき、limit で切れるのは recorded_at の古いほう・memory_id の大きいほう（残るのは新しいほう・小さいほう）", async () => {
      // recorded_at が memory_id の昇順に古→新の4件から、新しい2件。
      const byDate = await search(ctx, [1, 0, 0], {
        limit: 2,
        filter: { ...filter, subjectId: "dated-subject" },
      });
      expect(byDate).toEqual([subjectZerosByIdAsc[3], subjectZerosByIdAsc[2]]);

      // recorded_at が同点の4件から、memory_id の小さい2件。
      const byId = await search(ctx, [1, 0, 0], {
        limit: 2,
        filter: { ...filter, subjectId: "tied-subject" },
      });
      expect(byId).toEqual([tiedZeros[0], tiedZeros[1]]);

      const many = await searchMany(ctx, [{ key: "q", vector: [1, 0, 0] }], {
        limit: 2,
        filter: { ...filter, subjectId: "dated-subject" },
      });
      expect(many.get("q")).toEqual([subjectZerosByIdAsc[3], subjectZerosByIdAsc[2]]);
    });

    it("search: ゼロの候補にも filter（status）とテナントの境界が掛かる", async () => {
      const ids = await search(ctx, [1, 0, 0], {
        limit: 50,
        filter: { ...filter, status: ["active"] },
      });
      expect(ids).not.toContain(archivedZero);
      expect(ids).not.toContain(otherTenantZero);
      expect(ids).toEqual([
        nonZero.a,
        nonZero.c,
        nonZero.b,
        ...tiedZeros,
        ...datedZerosNewestFirst,
        ...subjectZerosNewestFirst(),
      ]);

      // ctx と filter.tenantId が食い違えば（ADR 0007）、どちらのテナントのゼロも出ない。
      expect(await search(otherCtx, [1, 0, 0], { limit: 50, filter })).toEqual([]);
    });

    it("searchMany: 各クエリで、search と同じ並び・同じ切れ方・全員1回ずつ", async () => {
      const opts = { limit: 5, filter: { ...filter, status: ["active" as const] } };
      const many = await searchMany(
        ctx,
        [
          { key: "q1", vector: [1, 0, 0] },
          { key: "q2", vector: [0, 1, 0] },
        ],
        opts,
      );

      expect(many.get("q1")).toEqual([nonZero.a, nonZero.c, nonZero.b, tiedZeros[0], tiedZeros[1]]);
      expect(many.get("q2")).toEqual([nonZero.b, nonZero.c, nonZero.a, tiedZeros[0], tiedZeros[1]]);

      const wide = await searchMany(ctx, [{ key: "q1", vector: [1, 0, 0] }], {
        limit: 50,
        filter: { ...filter, status: ["active"] },
      });
      expect(wide.get("q1")).toEqual([
        nonZero.a,
        nonZero.c,
        nonZero.b,
        ...tiedZeros,
        ...datedZerosNewestFirst,
        ...subjectZerosNewestFirst(),
      ]);
      const leak = await searchMany(ctx, [{ key: "q1", vector: [1, 0, 0] }], { limit: 50, filter });
      expect(leak.get("q1")).not.toContain(otherTenantZero);
    });
  },
);
