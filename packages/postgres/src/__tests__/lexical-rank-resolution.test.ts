import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #394（`ADR 0305`）: `coverage`/`rank` に、内容由来の分解能が無かった。
 *
 * [Issue #394](https://github.com/takecchi/mnemora/issues/394) 本文が
 * `lexical-store-index.test.ts` の `seedManyMemories`（20,000行、末尾の整数だけが違う
 * テンプレート文）で実測した現象——クエリ2語（`obsidian shards`）にヒットする400行が
 * 全部 `coverage=1`・`rank=0.16666667` で完全同点になる——を、**中身が真に異なる短い
 * fixture**（1行の `psql` ではなく、この repo の歯として）で再現する。
 *
 * 【実測】(手元 PostgreSQL 17.11、`initdb` で自前に立てたインスタンス、AGENTS.md の手順、
 * 2026-09-25) `TS_RANK_CD_NORMALIZATION = 32`（直す前の値）で、次の2つの `content` に
 * 対する `rank` を比べた:
 *
 * - `"obsidian shards"`（クエリそのもの、短く焦点が合っている）
 * - `"Yesterday we spent a long time discussing many unrelated topics such as weather
 *   patterns, quarterly budgets, travel plans, and eventually someone mentioned obsidian
 *   shards briefly before moving on to talk about lunch plans and other matters entirely
 *   unrelated to the original subject at hand."`（同じ2語を含むが、長く散漫）
 *
 * 直す前は両方とも `rank = 0.16666667` で完全同点だった——`coverage` も両方 `1` である。
 * ⟹ **20,000行 seed の重複が特殊なのではなく、`ts_rank_cd` に渡すクエリ語がどちらも
 * 一致箇所で隣接するとき、周囲の文脈量に関わらず cover density が同じ値になる**
 * ことが根の原因である（`ts_rank_cd` は既定で文書長を見ない——normalization 引数の
 * どのビットも立てていなかったため）。
 *
 * この歯は、その2つの `content` に対する `rank` が**割れる**ことを検査する
 * （直す前は赤、直した後は緑——変異試験は本 ADR 本文に記録する）。
 */

const TENANT = "lexical-rank-resolution-tenant";

async function createMemory(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  contentHash: string,
  content: string,
) {
  return memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, contentHash, content }),
  );
}

describe("PostgresLexicalStore.search — rank に内容由来の分解能を持たせる（Issue #394, ADR 0305）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("被覆率が同じ短文と長文散漫な文の rank が割れる — 直す前は完全同点だった", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const focused = await createMemory(memoryStore, ctx, "hash-focused", "obsidian shards");
    const diffuse = await createMemory(
      memoryStore,
      ctx,
      "hash-diffuse",
      "Yesterday we spent a long time discussing many unrelated topics such as weather " +
        "patterns, quarterly budgets, travel plans, and eventually someone mentioned " +
        "obsidian shards briefly before moving on to talk about lunch plans and other " +
        "matters entirely unrelated to the original subject at hand.",
    );

    const hits = await lexicalStore.search(ctx, "obsidian shards", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const focusedHit = hits.find((h) => h.memoryId === focused.id);
    const diffuseHit = hits.find((h) => h.memoryId === diffuse.id);
    expect(focusedHit).toBeDefined();
    expect(diffuseHit).toBeDefined();

    // 両方ともクエリ2語を含むので coverage は同値 (1) —— この歯が問うのは rank 側。
    expect(focusedHit!.coverage).toBe(1);
    expect(diffuseHit!.coverage).toBe(1);

    // 🔴 Issue #394 が指す穴そのもの。直す前はここが等しかった
    // （`rank_norm32` 実測値: 両方とも 0.16666667）。
    expect(focusedHit!.rank).not.toBe(diffuseHit!.rank);
    // 直した形（文書長を分母に持つ normalization ビットを足す）は、短く焦点の合った
    // 文のほうを高い rank にする——長い文ほど無関係な語で「薄まる」という方向。
    expect(focusedHit!.rank).toBeGreaterThan(diffuseHit!.rank);
  });

  it("内容が真に同一な行どうしは、直した後も完全に同点のまま — ADR 0175 の tie-break 契約を壊さない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const content = "widget alpha bravo tie-break resolution content";
    await createMemory(memoryStore, ctx, "hash-dup-a", content);
    await createMemory(memoryStore, ctx, "hash-dup-b", content);

    const hits = await lexicalStore.search(ctx, "widget", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.length).toBe(2);
    // 文書長も語の並びも完全に同一 —— 分解能を足しても、真に同一な内容は今も同点。
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);
  });

  it("末尾の整数だけが違うテンプレート文（20,000行 seed と同じ構造）は、直した後も同点のまま — 語数(lexeme 数)が変わらないため", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // `lexical-store-index.test.ts` の `seedManyMemories` と同じテンプレート
    // （`'obsidian shards glimmer in seed content ' || i`）。末尾の桁数が1〜5桁と
    // 揺れる点まで再現する——Issue #394 本文はこの範囲（i は 0..19999 の50刻み）を使った。
    const suffixes = [0, 7, 50, 999, 19_950];
    for (const i of suffixes) {
      await createMemory(
        memoryStore,
        ctx,
        `hash-template-${i}`,
        `obsidian shards glimmer in seed content ${i}`,
      );
    }

    const hits = await lexicalStore.search(ctx, "obsidian shards", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.length).toBe(suffixes.length);
    const [first, ...rest] = hits;
    // ⚠ これは「直っていない」ことを主張する歯である。⛔ 直そうとしていない。
    // `to_tsvector` は末尾の整数を(桁数に関わらず)1語彙として数えるため、
    // 文書長(lexeme 数)は5行とも同じ7語のまま変わらない——文書長由来の
    // normalization を足しても、この種の同点は割れない。Issue #394 本文が
    // 「これは合成 seed であり、割れないのが正しい」と明記している対象そのもの。
    for (const hit of rest) {
      expect(hit.coverage).toBe(first!.coverage);
      expect(hit.rank).toBe(first!.rank);
    }
  });
});
