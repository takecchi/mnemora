import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, RecallQuery, RecallResult, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * recall の絞り込み（attributes・labels・期間）の**振る舞い**を、選択率の3段（ほぼ全件・1%・0件）で縛る。
 *
 * 見るのは次の3点だけである:
 * 1. **該当が在るのに黙って0件にならない**（#363 と同じ形。ADR 0026 / 0193 / 0284）
 * 2. **別テナントの行が結果に出ない**（ADR 0007）
 * 3. **0件のときの名乗り方**: labels は `filtered`（`condition: 'taxonomy'`、ADR 0323）、
 *    期間は `filtered`（`condition: 'period'`、ADR 0059）、attributes は `omitted` が空
 *    （ADR 0312 決定6——attributes はスコープの定義の一部なので omitted に出さない）
 *
 * **計画の形（どの索引か・Seq Scan か）は縛らない。**プランナの見積もりで切り替わり、揺らぐため
 * （【実測 2026-09-27】同じ問い合わせでも、別テナントの行数で計画が変わった。記録は Issue #363 のコメント）。
 *
 * ## 分布（小さく・決定的に）
 * - 自テナント 400 行。`i % 100 === 0` の 4 行（1%）だけが `attributes.vip`・tags `rare`・
 *   2025-06-01 の出来事を持つ。全行が `attributes.region = jp`・tags `common` を持つ。
 * - 別テナント 100 行。**全行が問い合わせのベクトルとぴったり同じ向き**で、全部の絞り込みに当たる
 *   ——テナントの条件が抜ければ、真っ先に上位へ来る形にしてある。
 * - labels は `labels` 表に名前が在るときだけ絞り込みに参加する（ADR 0323 の参加資格）ので、
 *   両テナントに `common`・`rare` を proposed で入れる。
 */

const TENANT = "recall-filter-selectivity";
const OTHER = "recall-filter-selectivity-other";
const OWN_ROWS = 400;
const OTHER_ROWS = 100;
const QUERY_VECTOR = [1, 0, 0];

async function seed(pool: Pool): Promise<Set<string>> {
  const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
  const ownIds = new Set<string>();
  for (const [tenant, rows] of [
    [TENANT, OWN_ROWS],
    [OTHER, OTHER_ROWS],
  ] as const) {
    const ids = Array.from({ length: rows }, () => randomUUID());
    if (tenant === TENANT) ids.forEach((id) => ownIds.add(id));
    const everyRowMatches = tenant === OTHER;
    await pool.query(
      `INSERT INTO memories (id, tenant_id, content, content_hash, digest, digest_source, provenance_kind,
          provenance, status, tags, attributes, occurred_at, recorded_at, strength, half_life_hours,
          decay_floor_at, embedding_status, created_at, updated_at)
       SELECT m, $2, 'shared topic memory ' || i, md5(m::text), 'shared topic ' || i, 'llm', 'imported',
          '{"kind":"imported"}'::jsonb, 'active',
          CASE WHEN $3 OR i % 100 = 0 THEN ARRAY['common', 'rare'] ELSE ARRAY['common'] END,
          CASE WHEN $3 OR i % 100 = 0 THEN '{"region":"jp","vip":"yes"}'::jsonb ELSE '{"region":"jp"}'::jsonb END,
          CASE WHEN $3 OR i % 100 = 0 THEN '2025-06-01T00:00:00Z'::timestamptz
               ELSE '2020-01-01T00:00:00Z'::timestamptz + (i || ' hours')::interval END,
          now() - interval '1 hour', 1, 87600, now() + interval '3650 days', 'ready', now(), now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS t(m, i)`,
      [ids, tenant, everyRowMatches],
    );
    // 自テナント: 問い合わせに近いが少しずつずれた向き。別テナント: 問い合わせとぴったり同じ向き。
    await pool.query(
      `INSERT INTO ${table} (tenant_id, memory_id, embedding, model, created_at)
       SELECT $2, m,
          CASE WHEN $3 THEN '[1,0,0]'::vector
               ELSE ('[1,' || (0.2 * sin(i)) || ',' || (0.2 * cos(i)) || ']')::vector END,
          $4, now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS t(m, i)`,
      [ids, tenant, everyRowMatches, TEST_EMBEDDING_SPACE.model],
    );
    await pool.query(
      `INSERT INTO labels (id, tenant_id, name, status, proposed_count)
       VALUES (gen_random_uuid(), $1, 'common', 'proposed', 1), (gen_random_uuid(), $1, 'rare', 'proposed', 1)`,
      [tenant],
    );
  }
  await pool.query("ANALYZE memories");
  await pool.query(`ANALYZE ${table}`);
  return ownIds;
}

type Selectivity = "ほぼ全件" | "1%" | "0件";
const FILTERS: Record<
  "attributes" | "labels" | "期間",
  Record<Selectivity, Partial<RecallQuery>>
> = {
  attributes: {
    ほぼ全件: { attributes: { region: "jp" } },
    "1%": { attributes: { vip: "yes" } },
    "0件": { attributes: { vip: "never" } },
  },
  labels: {
    ほぼ全件: { labels: ["common"] },
    "1%": { labels: ["rare"] },
    "0件": { labels: ["no-such-label"] },
  },
  期間: {
    ほぼ全件: { occurredAfter: new Date("2019-01-01"), occurredBefore: new Date("2030-01-01") },
    "1%": { occurredAfter: new Date("2025-05-01"), occurredBefore: new Date("2025-07-01") },
    "0件": { occurredAfter: new Date("1990-01-01"), occurredBefore: new Date("1991-01-01") },
  },
};
/** 自テナントの中で、その選択率の絞り込みに当たる行数。 */
const IN_SCOPE: Record<Selectivity, number> = {
  ほぼ全件: OWN_ROWS,
  "1%": OWN_ROWS / 100,
  "0件": 0,
};
const LIMIT = 10;

const CASES = (Object.keys(FILTERS) as Array<keyof typeof FILTERS>).flatMap((kind) =>
  (Object.keys(FILTERS[kind]) as Selectivity[]).map((sel) => [kind, sel] as const),
);

describe("recall の絞り込み × 選択率: 黙って0件にならない・別テナントを返さない・0件の名乗り方（本物の Postgres）", () => {
  const ctx: Ctx = { tenantId: TENANT };
  let runtime: Runtime;
  let ownIds: Set<string>;

  beforeAll(async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    ownIds = await seed(pool);
    runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      lexicalStore: new PostgresLexicalStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async () => {
          throw new Error("unused");
        },
      },
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx, texts) => texts.map(() => QUERY_VECTOR),
      },
      hashContent: (content: string) => `sha256(${content})`,
    });
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function recall(kind: keyof typeof FILTERS, sel: Selectivity): Promise<RecallResult> {
    return runtime.recall(ctx, {
      text: "shared topic",
      limit: LIMIT,
      association: null,
      channels: ["ann", "lexical"],
      ...FILTERS[kind][sel],
    } as RecallQuery);
  }

  it.each(CASES)("%s × %s", async (kind, sel) => {
    const result = await recall(kind, sel);
    const returnedIds = result.memories.map((m) => m.memoryId);

    // 2. 別テナントの行が結果に出ない。
    expect(returnedIds.filter((id) => !ownIds.has(id))).toEqual([]);

    const inScope = IN_SCOPE[sel];
    if (inScope > 0) {
      // 1. 該当が在るのに黙って0件にならない（limit と該当数の小さい方まで返る）。
      expect(result.memories).toHaveLength(Math.min(LIMIT, inScope));
      return;
    }

    // 3. 0件のときの名乗り方。
    expect(result.memories).toEqual([]);
    if (kind === "attributes") {
      // ADR 0312 決定6: attributes はスコープの定義なので omitted に出さない。
      expect(result.omitted).toEqual([]);
    } else {
      const condition = kind === "labels" ? "taxonomy" : "period";
      expect(result.omitted).toContainEqual(
        expect.objectContaining({ kind: "filtered", condition, count: OWN_ROWS }),
      );
    }
  });
});
