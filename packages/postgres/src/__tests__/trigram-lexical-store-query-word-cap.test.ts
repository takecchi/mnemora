import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { LEXICAL_QUERY_MAX_DISTINCT_WORDS } from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #878（2026-09-26、クローン miku の判断）: `PostgresTrigramLexicalStore.search` の
 * ASCII 側にも、`PostgresLexicalStore` と同じ語数の上限
 * （{@link LEXICAL_QUERY_MAX_DISTINCT_WORDS}）を入れたことの実測。
 *
 * **⚠ この歯は UTF8 の `server_encoding` を前提とする**
 * （[ADR 0103](../../../docs/decisions/0103-negative-tooth-declares-its-precondition.md)
 * の規律。`trigram-lexical-store.postgres.test.ts` と同じ前提の測り方）。前提を満たさない
 * 環境では `describe.skip` 相当（`it.skip`）にする——`PostgresTrigramLexicalStore.create`
 * が投げることは既に別の歯（`trigram-lexical-store.postgres.test.ts`）が検査している。
 */

const TENANT = "trigram-query-word-cap-tenant";

function fillerWords(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `filler${i}`);
}

describe("PostgresTrigramLexicalStore.search: ASCII 側のクエリ語数の上限（Issue #878）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it(`ASCII: 上限（${LEXICAL_QUERY_MAX_DISTINCT_WORDS}）を超える語は使われない`, async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      // ADR 0103: この環境では前提（UTF8 等）が満たせない——`trigram-lexical-store.postgres.test.ts`
      // が別途この否定を検査済みであり、ここでは重ねて検査しない。
      return;
    }

    const memoryStore = new PostgresMemoryStore(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const ctx: Ctx = { tenantId: TENANT };

    const withinCap = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS);
    const beyondCapWord = "onlybeyondcap";

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-beyond-cap",
        content: `記憶の本文に ${beyondCapWord} という語だけを含む`,
      }),
    );

    const query = [...withinCap, beyondCapWord].join(" ");
    const hits = await trigramStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("ASCII 側が上限を超えて切り詰められても、日本語側の一致は影響を受けない", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      return;
    }

    const memoryStore = new PostgresMemoryStore(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const ctx: Ctx = { tenantId: TENANT };

    const japaneseContent = "田中さんが来週から新しいプロジェクトに参加します";
    const japaneseMemory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-japanese-with-many-ascii",
        content: japaneseContent,
      }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-japanese-with-many-ascii-noise",
        content: "無関係な埋め文",
      }),
    );

    // ASCII の異なる語を上限より多く含む（が、クエリ全体の文字数の上限
    // （LEXICAL_QUERY_MAX_TOTAL_CHARS）には触れない範囲に収める）。日本語部分
    // （田中さんについて…）はそのまま――ASCII 側の切り詰めが日本語側の語彙判定を
    // 壊さないことを見る。
    const asciiBeyondCap = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS + 5).join(" ");
    const query = `${asciiBeyondCap} 田中さんについて何か言ってましたか`;

    const hits = await trigramStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits.map((h) => h.memoryId)).toContain(japaneseMemory.id);
  });
});
