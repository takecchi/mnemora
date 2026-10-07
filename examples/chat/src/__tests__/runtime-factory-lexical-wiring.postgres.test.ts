import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 見分けには pg_proc を使う。テストの DB は UTF8 でどちらを使っても動き、動作では見分けられない。

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
