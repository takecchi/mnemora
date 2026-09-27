import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { closePostgresClient, createPostgresClient } from "../client.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  captureClientQuery,
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
} from "./test-db.js";

/**
 * `PostgresTrigramLexicalStore.search` は、`pg_trgm.word_similarity_threshold` をパラメータで渡し、
 * その検索のトランザクションの中だけで効かせる。
 *
 * - 閾値の設定の文は、数値を SQL の文面に持たない（パラメータとして渡る）。
 * - 検索の後、同じ接続の設定は既定の値のまま（トランザクションの外に漏れない）。
 *
 * SQL_ASCII の leg では `create()` が拒むので（ADR 0319）、その leg では `create()` の拒否だけを確かめる。
 */

const ctx: Ctx = { tenantId: "trigram-threshold-param" };
/** 既定（0.3）とも pg_trgm の既定（0.6）とも違う値。文面に現れないことを確かめる。 */
const THRESHOLD = 0.37;
const filter = { tenantId: ctx.tenantId };

afterAll(async () => {
  await closeTestClient();
});

async function trigramAvailable(): Promise<boolean> {
  const { db } = await getTestClient();
  const probe = await probeTrigramLexicalSupport(db);
  if (!probe.ok) {
    await expect(
      PostgresTrigramLexicalStore.create(db, { threshold: THRESHOLD }),
    ).rejects.toThrow();
  }
  return probe.ok;
}

describe("PostgresTrigramLexicalStore の閾値の渡し方", () => {
  it("閾値の設定の文は、数値を SQL の文面に持たず、パラメータとして渡す", async () => {
    if (!(await trigramAvailable())) return;
    const { db } = await getTestClient();
    const store = await PostgresTrigramLexicalStore.create(db, { threshold: THRESHOLD });

    const captured = await captureClientQuery(
      (text) => text.includes("word_similarity_threshold"),
      () => store.search(ctx, "東京", { limit: 5, filter }),
    );

    expect(captured.text).not.toContain(String(THRESHOLD));
    expect(captured.params).toContain(String(THRESHOLD));
  });

  it("検索の後、同じ接続の設定は既定の値のまま（トランザクションの外に漏れない）", async () => {
    if (!(await trigramAvailable())) return;
    // 接続を1本に絞り、検索に使った接続と、後で読む接続を同じにする。
    const client = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    try {
      const store = await PostgresTrigramLexicalStore.create(client.db, { threshold: THRESHOLD });
      const show = async () =>
        (
          (
            await client.db.execute(
              sql`SELECT current_setting('pg_trgm.word_similarity_threshold') AS v`,
            )
          ).rows[0] as { v: string }
        ).v;
      const before = await show();

      await store.search(ctx, "東京", { limit: 5, filter });

      expect(await show()).toBe(before);
      expect(Number(await show())).not.toBe(THRESHOLD);

      // 陽性対照: セッション全体に効く形で設定すると、同じ読み方で漏れが見える。
      await client.db.execute(
        sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(THRESHOLD)}, false)`,
      );
      expect(Number(await show())).toBe(THRESHOLD);
    } finally {
      await closePostgresClient(client);
    }
  });
});
