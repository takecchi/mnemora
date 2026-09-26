import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  LEXICAL_QUERY_MAX_WORD_CHARS,
  TRIGRAM_JAPANESE_QUERY_MAX_CHARS,
} from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #878（2026-09-26、クローン miku の判断）: `PostgresTrigramLexicalStore.search` の
 * 文字数の上限（ASCII 側: {@link LEXICAL_QUERY_MAX_WORD_CHARS}、日本語側:
 * {@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS}）の実測。
 *
 * **⚠ この歯は UTF8 の `server_encoding` を前提とする**（`trigram-lexical-store.postgres.test.ts`
 * と同じ前提の測り方、ADR 0103）。前提を満たさない環境では中身をスキップする。
 */

const TENANT = "trigram-query-char-cap-tenant";

describe("PostgresTrigramLexicalStore.search: クエリの文字数の上限（Issue #878）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it(`ASCII: 上限（${LEXICAL_QUERY_MAX_WORD_CHARS}文字）を超えた語は、先頭からその文字数だけに切り詰められた形で使われる`, async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      return;
    }

    const memoryStore = new PostgresMemoryStore(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const ctx: Ctx = { tenantId: TENANT };

    const wordAtCap = "z".repeat(LEXICAL_QUERY_MAX_WORD_CHARS);
    const queryWordBeyondCap = wordAtCap + "extratailbeyondcap";

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-char-cap-ascii",
        content: `記憶の本文に ${wordAtCap} という語だけを含む`,
      }),
    );

    const hits = await trigramStore.search(ctx, queryWordBeyondCap, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });

  it(`日本語: 上限（${TRIGRAM_JAPANESE_QUERY_MAX_CHARS}文字）を超えた非 ASCII の連なりは、先頭からその文字数だけに切り詰められた形で使われる`, async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      return;
    }

    const memoryStore = new PostgresMemoryStore(db);
    // 閾値をほぼ1（自己一致でなければ通らない値）にする——既定の閾値（0.3）では、
    // word_similarity が「部分一致」にも十分寛容な値を返すため、切り詰めの有無で
    // 一致/不一致が割れない（実測: 上限ちょうどの文字列と、それに30文字足した文字列との
    // word_similarity は 0.3 を大きく超える）。ほぼ1にすることで、「本文の語と完全に
    // 同じ文字列になったときだけ通る」ようにし、切り詰めが実際に起きたかどうかの
    // 判定に使う。
    const trigramStore = await PostgresTrigramLexicalStore.create(db, { threshold: 0.95 });
    const ctx: Ctx = { tenantId: TENANT };

    // 上限「ちょうど」の文字数の日本語の文字列を本文に置く。クエリはそれに追加の
    // 文字列を続けた、より長い非 ASCII の連なり——切り詰めが効いていれば
    // word_similarity の対象が本文の語と文字列として完全に一致し（similarity = 1）、
    // 効いていなければ本文より長い文字列のままなので閾値（0.95）を満たさない。
    const atCap = Array.from(
      { length: TRIGRAM_JAPANESE_QUERY_MAX_CHARS },
      (_, i) => "あいうえおかきくけこさしすせそたちつてとなにぬねの"[i % 25],
    ).join("");
    const beyondCap = atCap + "はまやらわをんがぎぐげござじずぜぞだぢづでど";
    expect(beyondCap.length).toBeGreaterThan(TRIGRAM_JAPANESE_QUERY_MAX_CHARS);
    expect(beyondCap.startsWith(atCap)).toBe(true);

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-trigram-char-cap-japanese",
        content: atCap,
      }),
    );

    const hits = await trigramStore.search(ctx, beyondCap, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits.map((h) => h.memoryId)).toHaveLength(1);
  });
});
