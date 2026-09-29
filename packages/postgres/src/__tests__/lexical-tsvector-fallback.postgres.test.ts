import { randomBytes } from "node:crypto";
import type { Ctx } from "@mnemora/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `mnemora_lexical_tsvector`（`migrations/0025_lexical_tsvector_fallback.sql`、
 * Issue #1222、ADR 0364）の2つの主張を縛る。
 *
 * (i) **今まで通っていた本文では、新関数は旧式と完全一致する。**
 *     `to_tsvector('simple', mnemora_lexical_normalize(content))`（旧式、1MBに収まる
 *     本文なら例外にならない）と `mnemora_lexical_tsvector(content)`（新関数）を、
 *     同じ本文に対して直接 SQL で当て、`::text`・`ts_rank_cd`・
 *     `PostgresLexicalStore.search` の結果と順位が一致することを見る。
 * (ii) **1MBを超える本文（先頭150,000文字だけが対象になる側）でも INSERT が通り、
 *      先頭の語は語彙検索で引ける。**（`whole-observation-fallback-size.postgres.test.ts`
 *      が `runtime.observe()`/`createMemory` 経由でこれを縛っている——ここでは
 *      `PostgresTrigramLexicalStore` 側の同じ主張を足す。）
 *
 * N=150,000 の安全性の根拠（理論上限・実測）は `migrations/0025_*.sql` の冒頭コメントと
 * ADR 0364「N の実測」に書いてある——ここでは繰り返さない。
 */

const TENANT = "lexical-tsvector-fallback-tenant";

/** 旧式（0008/0009 のまま）を直接 SQL で当てる。1MBに収まる本文専用（超えると例外）。 */
async function oldExpressionTsvectorText(
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
  content: string,
): Promise<string> {
  const result = await db.execute(
    sql`SELECT to_tsvector('simple', mnemora_lexical_normalize(${content}))::text AS tsv`,
  );
  return (result.rows[0] as { tsv: string }).tsv;
}

async function newFunctionTsvectorText(
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
  content: string,
): Promise<string> {
  const result = await db.execute(sql`SELECT mnemora_lexical_tsvector(${content})::text AS tsv`);
  return (result.rows[0] as { tsv: string }).tsv;
}

/** 12桁の16進の語を空白で区切り、およそ `bytes` バイトにする（重複の無い語、tsvectorが大きくなる）。 */
function manyWords(bytes: number): string {
  const words: string[] = [];
  for (let n = 0; n < bytes; n += 13) words.push(randomBytes(6).toString("hex"));
  return words.join(" ");
}

// 旧式でもまだ例外にならない、1MBの上限に近い大きな本文。
// 【実測】manyWords(650_000) は旧式の tsvector が1,060,793バイト（::text）で既に例外
// （`string is too long for tsvector`）。manyWords(600_000) は978,413バイトで収まる。
// ⟹ 600,000バイトより小さい550,000バイトを「上限直前」として使う（安全余裕を持たせる）。
const NEAR_LIMIT_BODIES: Record<string, string> = {
  日本語: "四半期レビューでPROJ-1234の納期が来週まで延びました。".repeat(2000),
  識別子混在: Array.from({ length: 20000 }, (_, i) => `PROJ-${i} TASK-${i} user${i}`).join(" "),
  英数字混在: manyWords(300_000),
  上限直前: manyWords(550_000),
};

describe("mnemora_lexical_tsvector: 旧式との完全一致（Issue #1222、ADR 0364、歯 (i)）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  for (const [label, content] of Object.entries(NEAR_LIMIT_BODIES)) {
    it(`${label}: 新関数の tsvector（::text）は旧式と1バイトも違わない`, async () => {
      const { db } = await getTestClient();
      const [oldText, newText] = await Promise.all([
        oldExpressionTsvectorText(db, content),
        newFunctionTsvectorText(db, content),
      ]);
      expect(newText).toBe(oldText);
    });

    it(`${label}: ts_rank_cd の値も旧式と一致する`, async () => {
      const { db } = await getTestClient();
      const query = "PROJ-1234 TASK-5 user1 四半期 レビュー";
      const result = await db.execute(sql`
        SELECT
          ts_rank_cd(to_tsvector('simple', mnemora_lexical_normalize(${content})),
                     mnemora_lexical_query_or(${query}), 33) AS "old",
          ts_rank_cd(mnemora_lexical_tsvector(${content}),
                     mnemora_lexical_query_or(${query}), 33) AS "new"
      `);
      const row = result.rows[0] as { old: number; new: number };
      expect(row.new).toBe(row.old);
    });
  }

  it("PostgresLexicalStore.search の結果と順位は、索引の作り直し前後で変わらない（複数の本文を同時に検索）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const fixtures = Object.entries(NEAR_LIMIT_BODIES);
    for (const [label, content] of fixtures) {
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          contentHash: `parity-${label}`,
          content,
        }),
      );
    }

    // 新関数を使う本番経路の結果。
    const viaSearch = await lexicalStore.search(ctx, "PROJ-1234 TASK-5 user1 四半期", {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    // 旧式で直接組み立てた対照（0008/0009 の式そのまま、mnemora_lexical_tsvector を使わない）。
    const oldResult = await db.execute(sql`
      SELECT id AS memory_id,
             mnemora_lexical_coverage(content, ${"PROJ-1234 TASK-5 user1 四半期"}) AS coverage,
             ts_rank_cd(to_tsvector('simple', mnemora_lexical_normalize(content)),
                        mnemora_lexical_query_or(${"PROJ-1234 TASK-5 user1 四半期"}), 33) AS rank
      FROM memories
      WHERE tenant_id = ${TENANT} AND status IN ('active', 'contested')
        AND to_tsvector('simple', mnemora_lexical_normalize(content))
            @@ mnemora_lexical_query_or(${"PROJ-1234 TASK-5 user1 四半期"})
      ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
      LIMIT 50
    `);
    const oldRows = oldResult.rows as unknown as Array<{
      memory_id: string;
      coverage: number;
      rank: number;
    }>;

    expect(viaSearch.map((h) => h.memoryId)).toEqual(oldRows.map((r) => r.memory_id));
    expect(viaSearch.map((h) => h.coverage)).toEqual(oldRows.map((r) => r.coverage));
    expect(viaSearch.map((h) => h.rank)).toEqual(oldRows.map((r) => r.rank));
  });
});

describe("PostgresTrigramLexicalStore: 1MBを超える本文でも INSERT が通り、先頭の語が引ける（Issue #1222）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("1.2MBの本文: createMemory が通り、先頭の一意な語をASCII側で引ける", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      // ADR 0103: この環境では pg_trgm の前提（UTF8 等）が満たせない——
      // trigram-lexical-store.postgres.test.ts が別途この否定を検査済み。
      return;
    }

    const memoryStore = new PostgresMemoryStore(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const ctx: Ctx = { tenantId: TENANT };
    const content = `MNEMORATRIGRAMFRONT ${manyWords(1_200_000)} MNEMORATRIGRAMTAIL`;

    const created = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "trigram-1.2mb",
        content,
      }),
    );
    expect(created.content).toBe(content);

    const hits = await trigramStore.search(ctx, "MNEMORATRIGRAMFRONT", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits.map((h) => h.memoryId)).toContain(created.id);
  });
});
