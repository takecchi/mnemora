import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LexicalStore, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryLexicalStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 語彙チャンネルのクエリで、語の途中の `"` を空白として扱う（本文と同じ規則で語に分ける）。
 *
 * `mnemora_lexical_query_tsqueries`（`migrations/0009`）は、各語を `"…"` で囲んで
 * `websearch_to_tsquery` に渡す前に、語の中の `"` を取り除いていた。取り除くときに
 * **空白ではなく詰めていた**ので、`x"y` は1語 `xy` になり、本文側（`to_tsvector` は `x"y` を
 * `x` と `y` に分ける）と噛み合わなかった——本文と同じ文字列で探しても0件だった。
 * 【実測 2026-09-27】testkit の `InMemoryLexicalStore` は一致する。語の端の `"`（`"PROJ-1234"`）は
 * 詰めても影響が無い。`migrations/0023` で `"` を空白に置き換えた（関数の本体はその1か所だけ変えた）。
 *
 * trigram の語彙検索（`PostgresTrigramLexicalStore`）は ASCII 側で同じ関数を使うので、同じく直る。
 * SQL_ASCII の leg では `create()` が拒むので（ADR 0319）、その leg の trigram の組では `create()` の
 * 拒否だけを確かめ、検索は飛ばす（`trigram-lexical-store-threshold-param.postgres.test.ts` と同じ扱い）。
 */

const ctx: Ctx = { tenantId: "lexical-query-inner-quote" };

const CASES: Array<[string, string, string]> = [
  ['語の途中の "', 'x"y が本文', 'x"y'],
  ['語の途中の " を2つ', 'say"hi"there now', 'say"hi"there'],
  ['語の端の "（今までどおり）', "PROJ-1234 done", '"PROJ-1234"'],
  // 変えるのは `"` だけ（#1187）: `.` などを空白にすると、これらが語に割られて引けなくなる。
  ["IP アドレス", "server 10.0.0.1 is up", "10.0.0.1"],
  ["バージョン番号", "released v1.2.3 today", "v1.2.3"],
  ["ファイル名", "edit foo.ts now", "foo.ts"],
];

/** 本文 `content` の記憶と、`other` の記憶を置き、`query` で探して当たった本文を返す。 */
async function searchContents(
  kit: { memoryStore: MemoryStore; lexicalStore: LexicalStore },
  contents: string[],
  query: string,
): Promise<string[]> {
  const byId = new Map<string, string>();
  for (const content of contents) {
    const m = await kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, content, contentHash: content }),
    );
    byId.set(m.id, content);
  }
  const hits = await kit.lexicalStore.search(ctx, query, {
    limit: 10,
    filter: { tenantId: ctx.tenantId },
  });
  return hits.map((h) => byId.get(h.memoryId)!).sort();
}

/** `null` は、この環境ではその組を当てられない（trigram が SQL_ASCII で拒まれた）ことを表す。 */
type Make = () => Promise<{ memoryStore: MemoryStore; lexicalStore: LexicalStore } | null>;

const KITS: Array<[string, Make]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return { memoryStore, lexicalStore: new InMemoryLexicalStore(memoryStore) };
    },
  ],
  [
    "Postgres（tsvector）",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return {
        memoryStore: new PostgresMemoryStore(db),
        lexicalStore: new PostgresLexicalStore(db),
      };
    },
  ],
  [
    "Postgres（trigram）",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const probe = await probeTrigramLexicalSupport(db);
      if (!probe.ok) {
        // SQL_ASCII など: create() が拒むことだけを確かめる（ADR 0319）。
        await expect(PostgresTrigramLexicalStore.create(db)).rejects.toThrow();
        return null;
      }
      return {
        memoryStore: new PostgresMemoryStore(db),
        lexicalStore: await PostgresTrigramLexicalStore.create(db),
      };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

for (const [name, make] of KITS) {
  describe(`${name}: 語彙のクエリの " の扱い`, () => {
    it.each(CASES)("%s: 本文と同じ文字列で探すと当たる", async (_label, content, query) => {
      const kit = await make();
      if (kit === null) return;
      const { memoryStore, lexicalStore } = kit;
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, content, contentHash: content }),
      );
      const hits = await lexicalStore.search(ctx, query, {
        limit: 5,
        filter: { tenantId: ctx.tenantId },
      });
      expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
      expect(hits[0]!.coverage).toBe(1);
    });

    // 各語を `"…"` で囲む約束（0009 から続く）: `-` や `or` が検索記法として効かない。
    it("-1234 で探すと、-1234 を含む記憶だけが当たる（NOT として効かない）", async () => {
      const kit = await make();
      if (kit === null) return;
      const contents = ["ticket -1234 done", "other 5678 text"];
      expect(await searchContents(kit, contents, "-1234")).toEqual(["ticket -1234 done"]);
    });

    it("or だけのクエリで探すと、or を含む記憶だけが当たる（演算子として効かない）", async () => {
      const kit = await make();
      if (kit === null) return;
      const contents = ["this or that", "unrelated words"];
      expect(await searchContents(kit, contents, "or")).toEqual(["this or that"]);
    });

    // 語の途中の `"` は隣接を求める（`'x' <-> 'y'`）。隣接を求めない AND だと当たってしまう。
    it('本文 "y z x" は x"y で探しても当たらない', async () => {
      const kit = await make();
      if (kit === null) return;
      expect(await searchContents(kit, ["y z x"], 'x"y')).toEqual([]);
    });
  });
}

// `mnemora_lexical_query_tsqueries` の宣言（0023 は `IMMUTABLE PARALLEL SAFE`・引数 `(text)` を
// 0009 から変えていない）と、`mnemora_lexical%` の同名の多重定義が無いこと。
describe("mnemora_lexical_query_tsqueries の宣言", () => {
  it("IMMUTABLE・PARALLEL SAFE・引数は (text) だけ", async () => {
    const { pool } = await getTestClient();
    const { rows } = await pool.query<{
      provolatile: string;
      proparallel: string;
      args: string;
    }>(
      `SELECT provolatile, proparallel, pg_get_function_identity_arguments(oid) AS args
         FROM pg_proc
        WHERE proname = 'mnemora_lexical_query_tsqueries'
          AND pronamespace = current_schema()::regnamespace`,
    );
    expect(rows).toEqual([{ provolatile: "i", proparallel: "s", args: "text" }]);
  });

  it("mnemora_lexical% の関数に同名の多重定義が無い", async () => {
    const { pool } = await getTestClient();
    const { rows } = await pool.query<{ proname: string; n: number }>(
      `SELECT proname, count(*)::int AS n
         FROM pg_proc
        WHERE proname LIKE 'mnemora\\_lexical%'
          AND pronamespace = current_schema()::regnamespace
        GROUP BY proname
       HAVING count(*) > 1`,
    );
    expect(rows).toEqual([]);
  });
});
