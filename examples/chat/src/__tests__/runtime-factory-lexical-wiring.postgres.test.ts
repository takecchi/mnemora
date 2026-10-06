import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `createExampleRuntime` の語彙 store の配線（Issue #278・ADR 0319 決定6。Issue #1775 の #738 の L4）。
 *
 * 既定（`MNEMORA_LEXICAL_STORE` 未指定・`"default"`）は `PostgresLexicalStore` で、pg_trgm の関数を作らない。
 * `"trigram"` を明示したときだけ `PostgresTrigramLexicalStore.create()` を呼ぶ（`CREATE EXTENSION` と
 * `mnemora_trigram_hybrid_coverage` の作成を発行する）。`selectLexicalStoreMode` の純関数の歯はあるが、
 * 配線は見ていなかった——「既定が変わらないこと」の担保（PR 本文）の要。既定の利用者に拡張の作成権限を
 * 求めてしまう誤りを縛る。
 *
 * 見分けには `pg_proc` を使う。`create()` が入れる関数が、既定では無く、`"trigram"` では在ることを見る
 * （テストの DB は UTF8 なので、どちらを使っても動き、動作だけでは見分けられない）。
 */

async function trigramFunctionCount(): Promise<number> {
  const { pool } = await getTestClient();
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'mnemora_trigram_hybrid_coverage'",
  );
  return rows[0]!.n;
}

async function dropTrigramFunction(): Promise<void> {
  const { pool } = await getTestClient();
  await pool.query("DROP FUNCTION IF EXISTS mnemora_trigram_hybrid_coverage(text, text, float8)");
}

beforeEach(async () => {
  await resetTestDatabase();
  await dropTrigramFunction();
});

afterAll(async () => {
  await dropTrigramFunction();
  await closeTestClient();
});

describe("createExampleRuntime: 語彙 store の配線（ADR 0319 決定6）", () => {
  it("既定（env が空・MNEMORA_LEXICAL_STORE=default）では pg_trgm の関数を作らず、trigram を明示したときだけ作る", async () => {
    for (const env of [{}, { MNEMORA_LEXICAL_STORE: "default" }]) {
      const handle = await createExampleRuntime(requireDatabaseUrl(), env);
      try {
        expect(await trigramFunctionCount()).toBe(0);
      } finally {
        await handle.close();
      }
    }

    // 陽性対照: trigram を明示すると関数が作られる（この歯の「無い」が、見方の誤りでないことの確認）。
    const trigram = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LEXICAL_STORE: "trigram",
    });
    try {
      expect(await trigramFunctionCount()).toBe(1);
    } finally {
      await trigram.close();
    }
  });
});
