import { afterAll, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * 一般形の歯: public スキーマの**全ての外部キー**について、参照元（子）テーブルに
 * 「先頭列が FK 列」の索引が在ることを縛る。
 *
 * 背景: 親の行を消す（`eraseTenant` など）と、Postgres は子テーブルへ
 * `WHERE <fk列> = $1` の RI 検査を行う。子側に先頭列が FK 列の索引が無いと、
 * 消す行ごとに子テーブルを全走査する。`erase-tenant-fk-indexes.postgres.test.ts`
 * （0027 の歯）は索引名の固定表を持つため、**次に外部キーを足したときに気づけない**。
 * この歯は `pg_constraint` から外部キーを数え上げるので、固定表を持たない。
 *
 * 判定:
 * - 単一列 FK: 索引の先頭列が FK 列であること。
 * - 複数列 FK: 索引の先頭 n 列（n = FK の列数）の**集合**が FK 列の集合と一致すること
 *   （順序は問わない。RI 検査は等値条件の AND なので、先頭 n 列が同じ集合なら効く）。
 * - **部分索引（WHERE 付き）も「在る」と見なす**（例: `memories.contested_with_id` の
 *   `idx_memories_contested_with`）。NULL でない行だけを索引にした部分索引は、
 *   RI 検査の `= $1`（NULL とは等しくならない）を述語が含意するため使える。
 *   ただし式索引の列（indkey = 0）と、無効な索引（indisvalid = false）は数えない。
 * - 埋め込み空間テーブル（動的に作られる）も public に在れば同じ規則で数える。
 *
 * ⚠ **migration の本数にも索引名にも触れない**（`AGENTS.md`「数を、道具と生成物に焼き込まない」）。
 *
 * 例外（下の {@link EXEMPT}）は、外部キーの名前・理由と一緒にここへ名指しで書く。
 * 黙って除外しない。
 */

afterAll(async () => {
  await closeTestClient();
});

/** `"<子テーブル>.<制約名>"` → 索引を要しない理由。空であること（例外が要る場合だけ足す）。 */
const EXEMPT: Record<string, string> = {};

interface FkRow {
  child: string;
  conname: string;
  fk_cols: string[];
  parent: string;
  index_keys: string[]; // 各索引の indkey（空白区切り attnum 列）を、attname のカンマ区切りへ直したもの
}

describe("外部キーの参照元に、先頭列が FK 列の索引が在る（一般形）", () => {
  it("public スキーマの全ての外部キーが、先頭列一致の索引（部分索引も可）を持つ", async () => {
    const { pool } = await getTestClient();
    const res = await pool.query<FkRow>(`
      SELECT
        cl.relname AS child,
        c.conname,
        pcl.relname AS parent,
        (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS fk_cols,
        COALESCE((
          SELECT array_agg(
            (SELECT string_agg(COALESCE(a.attname::text, '<expr>'), ',' ORDER BY k.ord)
               FROM unnest(string_to_array(i.indkey::text, ' ')::int2[]) WITH ORDINALITY AS k(attnum, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          )
          FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indisvalid
        ), ARRAY[]::text[]) AS index_keys
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class pcl ON pcl.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
      ORDER BY cl.relname, c.conname
    `);

    // 数え上げが空振りしていないこと（スキーマ名の間違い等で 0 件になると、下が素通りになる）。
    expect(res.rows.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const row of res.rows) {
      const key = `${row.child}.${row.conname}`;
      if (key in EXEMPT) continue;
      const n = row.fk_cols.length;
      const want = [...row.fk_cols].sort().join(",");
      const covered = row.index_keys.some((cols) => {
        const head = cols.split(",").slice(0, n);
        return head.length === n && [...head].sort().join(",") === want;
      });
      if (!covered) {
        missing.push(
          `${key}: ${row.child}(${row.fk_cols.join(", ")}) -> ${row.parent} に、先頭列が (${row.fk_cols.join(", ")}) の索引が無い`,
        );
      }
    }
    expect(missing).toEqual([]);
  });

  it("EXEMPT の各項目は、実在する外部キーを指し、理由が空でない（死んだ例外を残さない）", async () => {
    const { pool } = await getTestClient();
    const res = await pool.query<{ key: string }>(`
      SELECT cl.relname || '.' || c.conname AS key
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
    `);
    const existing = new Set(res.rows.map((r) => r.key));
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect({ key, exists: existing.has(key) }).toEqual({ key, exists: true });
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});
