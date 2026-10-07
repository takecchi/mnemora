import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LexicalHit, LexicalStore } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 語彙チャンネルの `search()` が、同点のときの並びと `limit` による切り詰めを決定的に返すこと
 * （`coverage` → `rank` → `recorded_at` 降順 → `id` 昇順の4段）。
 *
 * 行は生 SQL で入れる。`id` と `created_at` と `occurred_at` を自分で決め、挿入順・`id` の大小・
 * `created_at` の順・`occurred_at` の順が `recorded_at` の順と食い違うようにするため。
 * `createMemory` 経由だと `id` が乱数で、挿入順が `recorded_at` と揃ってしまい、
 * 「`id` に落ちる」「物理順に落ちる」実装も、たまたま期待どおりに並ぶ。
 *
 * trigram の store も同じ並びを約束している（`PostgresTrigramLexicalStore` の doc）ので、同じ筋書きを通す。
 */

const TENANT = "lexical-tiebreak-recheck";
const ctx: Ctx = { tenantId: TENANT };

const ID_LOW = "00000000-0000-4000-8000-000000000001";
const ID_MID = "7fffffff-0000-4000-8000-000000000002";
const ID_HIGH = "ffffffff-0000-4000-8000-000000000003";

interface RawRow {
  id: string;
  content: string;
  recordedAt: string;
  createdAt?: string;
  occurredAt?: string | null;
}

async function insertRows(rows: RawRow[]): Promise<void> {
  const { pool } = await getTestClient();
  for (const row of rows) {
    await pool.query(
      `INSERT INTO memories (
         id, tenant_id, content, content_hash, digest, digest_source,
         provenance_kind, provenance, status, tags, recorded_at, occurred_at,
         strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'digest', 'llm',
         'imported', '{"kind":"imported"}'::jsonb, 'active', '{}'::text[], $5, $6,
         1.0, 720, now() + interval '30 days', 'ready', $7, $7
       )`,
      [
        row.id,
        TENANT,
        row.content,
        `hash-${row.id}`,
        row.recordedAt,
        row.occurredAt ?? null,
        row.createdAt ?? row.recordedAt,
      ],
    );
  }
}

type StoreKind = "lexical" | "trigram";

async function makeStore(kind: StoreKind, db: Db): Promise<LexicalStore | null> {
  if (kind === "lexical") {
    return new PostgresLexicalStore(db);
  }
  if (!(await probeTrigramLexicalSupport(db)).ok) {
    return null;
  }
  return PostgresTrigramLexicalStore.create(db);
}

async function search(
  kind: StoreKind,
  query: string,
  limit: number,
): Promise<{ hits: LexicalHit[] } | null> {
  const { db } = await getTestClient();
  const store = await makeStore(kind, db);
  if (store === null) {
    return null;
  }
  const hits = await store.search(ctx, query, { limit, filter: { tenantId: TENANT } });
  return { hits };
}

const SAME = "widget alpha bravo tie-break content";

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

describe.each<StoreKind>(["lexical", "trigram"])(
  "語彙チャンネル（%s）の search() の並び",
  (kind) => {
    it.each([
      ["id の大きい行を先に入れる", [ID_HIGH, ID_LOW]],
      ["id の小さい行を先に入れる", [ID_LOW, ID_HIGH]],
    ])("recorded_at まで同じなら id の昇順（%s）", async (_label, insertOrder) => {
      await insertRows(
        insertOrder.map((id) => ({ id, content: SAME, recordedAt: "2026-01-01T00:00:00Z" })),
      );

      const result = await search(kind, "widget", 10);
      if (result === null) return;

      expect(result.hits.map((h) => h.memoryId)).toEqual([ID_LOW, ID_HIGH]);
      expect(result.hits[0]!.rank).toBe(result.hits[1]!.rank);
    });

    it.each([
      ["recorded_at の古い順に入れる", [0, 1, 2]],
      ["recorded_at の新しい順に入れる", [2, 1, 0]],
    ])(
      "coverage・rank が同点なら recorded_at の新しい順（%s。id・created_at・occurred_at は逆順にしてある）",
      async (_label, insertOrder) => {
        // recorded_at: [0] < [1] < [2]。id は [0] が最小、created_at と occurred_at は [0] が最新。
        const rows: RawRow[] = [
          {
            id: ID_LOW,
            content: SAME,
            recordedAt: "2026-01-01T00:00:00Z",
            createdAt: "2026-03-03T00:00:00Z",
            occurredAt: "2026-03-03T00:00:00Z",
          },
          {
            id: ID_MID,
            content: SAME,
            recordedAt: "2026-01-02T00:00:00Z",
            createdAt: "2026-03-02T00:00:00Z",
            occurredAt: "2026-03-02T00:00:00Z",
          },
          {
            id: ID_HIGH,
            content: SAME,
            recordedAt: "2026-01-03T00:00:00Z",
            createdAt: "2026-03-01T00:00:00Z",
            occurredAt: "2026-03-01T00:00:00Z",
          },
        ];
        await insertRows(insertOrder.map((i) => rows[i]!));

        const result = await search(kind, "widget", 10);
        if (result === null) return;

        expect(result.hits.map((h) => h.memoryId)).toEqual([ID_HIGH, ID_MID, ID_LOW]);
      },
    );

    it("limit は同点の中から recorded_at の新しい行を残し、recorded_at まで同じなら id の小さい行を残す", async () => {
      await insertRows([
        { id: ID_LOW, content: SAME, recordedAt: "2026-01-01T00:00:00Z" },
        { id: ID_MID, content: SAME, recordedAt: "2026-01-02T00:00:00Z" },
        { id: ID_HIGH, content: SAME, recordedAt: "2026-01-02T00:00:00Z" },
      ]);

      const result = await search(kind, "widget", 2);
      if (result === null) return;

      expect(result.hits.map((h) => h.memoryId)).toEqual([ID_MID, ID_HIGH]);
    });

    it("coverage が高い行は、recorded_at が古くても rank が低くても先に来る", async () => {
      await insertRows([
        { id: ID_HIGH, content: "widget", recordedAt: "2026-01-03T00:00:00Z" },
        {
          id: ID_LOW,
          content: "widget gadget plus a good many other unrelated words around them",
          recordedAt: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await search(kind, "widget gadget", 10);
      if (result === null) return;

      expect(result.hits.map((h) => h.memoryId)).toEqual([ID_LOW, ID_HIGH]);
      expect(result.hits[0]!.coverage).toBeGreaterThan(result.hits[1]!.coverage);
    });

    it("coverage が同じなら rank の高い行が、recorded_at が古くても先に来る", async () => {
      await insertRows([
        { id: ID_LOW, content: "widget", recordedAt: "2026-01-01T00:00:00Z" },
        {
          id: ID_HIGH,
          content: "widget with a good many other unrelated words trailing along behind it",
          recordedAt: "2026-01-03T00:00:00Z",
        },
      ]);

      const result = await search(kind, "widget", 10);
      if (result === null) return;

      expect(result.hits[0]!.coverage).toBe(result.hits[1]!.coverage);
      expect(result.hits[0]!.rank).toBeGreaterThan(result.hits[1]!.rank);
      expect(result.hits.map((h) => h.memoryId)).toEqual([ID_LOW, ID_HIGH]);
    });
  },
);
