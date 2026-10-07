import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  LEXICAL_QUERY_MAX_TOTAL_CHARS,
  TRIGRAM_JAPANESE_QUERY_MAX_CHARS,
} from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * クエリの文字数の上限の、2つの境界。
 *
 * 1. クエリ全体の文字数の上限は、日本語側にも効く（ASCII 側だけに効かせない）。
 *    上限より後ろにしかない日本語は使われず、上限の内側にある日本語は使われる。
 * 2. 日本語側の上限（{@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS}）は、先頭から「ちょうど」その文字数まで
 *    を使う（1文字少なく切ると、上限ちょうどの本文との自己一致が崩れる）。
 *
 * ⚠ UTF8 の `server_encoding` を前提とする。
 */

const TENANT = "trigram-query-cap-boundary-tenant";
const KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねの";

function kana(length: number): string {
  return Array.from({ length }, (_, i) => KANA[i % KANA.length]).join("");
}

describe("PostgresTrigramLexicalStore.search: 上限の境界（#919）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("全体の文字数の上限は日本語側にも効く：上限より後ろにしかない日本語は使われず、内側にある日本語は使われる", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      return;
    }
    const memoryStore = new PostgresMemoryStore(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db, { threshold: 0.95 });
    const ctx: Ctx = { tenantId: TENANT };

    const ja = kana(30);
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-total-cap-ja",
        content: ja,
      }),
    );

    // 日本語が全体の上限の外側にある（先頭の ASCII の語が上限の手前までを埋める）
    const beyond = `${"q".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS)} ${ja}`;
    expect(beyond.length).toBeGreaterThan(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    const beyondHits = await trigramStore.search(ctx, beyond, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });
    expect(beyondHits).toHaveLength(0);

    // 同じ日本語が上限の内側にあれば使われる（切りすぎていない）
    const inside = `${"q".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS - 100)} ${ja}`;
    expect(inside.length).toBeLessThanOrEqual(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    const insideHits = await trigramStore.search(ctx, inside, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });
    expect(insideHits).toHaveLength(1);
  });

  it(`日本語側の上限は先頭から ${TRIGRAM_JAPANESE_QUERY_MAX_CHARS} 文字目まで使う：上限ちょうどの本文は、1文字も欠けずに自己一致する`, async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      return;
    }
    const memoryStore = new PostgresMemoryStore(db);
    // 自己一致（similarity = 1）でなければ通らない閾値。1文字でも少なく切ると、末尾の
    // 語尾のトライグラムが本文側と合わず similarity が 1 を割る。
    // `trigram-lexical-store-query-char-cap.test.ts` の 0.95 では、この1文字の差を拾えない。
    const trigramStore = await PostgresTrigramLexicalStore.create(db, { threshold: 0.995 });
    const ctx: Ctx = { tenantId: TENANT };

    const atCap = kana(TRIGRAM_JAPANESE_QUERY_MAX_CHARS);
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-ja-cap-exact",
        content: atCap,
      }),
    );

    const hits = await trigramStore.search(ctx, atCap + "はまやらわをん", {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits).toHaveLength(1);
  });
});
