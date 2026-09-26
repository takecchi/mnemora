// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #951: `InMemoryLexicalStore`（このファイルが検査する fake）と
// `PostgresLexicalStore` とで、非 ASCII を含む語の一致判定が分かれていた。3つの機序:
//
//   1. クエリ側の非 ASCII 落とし（`mnemora_lexical_query_terms`）——非 ASCII だけの
//      クエリ（ギリシャ文字・日本語等）は、postgres では語彙が0個になり常に0件。
//   2. 語末シグマ等、`lower()` と `toLowerCase()` の細部の食い違い（このテストでは、
//      1 の非 ASCII 落としが先に効くため、実際には表面化しない——下の「確かめたこと」
//      参照）。
//   3. ASCII 境界での分割（`mnemora_lexical_normalize`）——ASCII の連なりの前後に
//      空白を入れてから小文字化するため、小文字化で ASCII 化する非 ASCII 文字
//      （例: ケルビン記号 U+212A → `k`）が隣の ASCII 文字と癒着しない。
//
// 期待値はすべて、本物の Postgres 17.11（pgvector 0.8.0）に対し
// `PostgresLexicalStore.search` を実際に呼んで実測した値である——CI の2 regime
// （UTF8 + en_US.UTF-8、SQL_ASCII + C）の両方で同じ結果になることを確認済み
// （下の各 it のコメント参照。「確かめていないこと」は末尾にまとめる）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "lexical-postgres-alignment-tenant";
const ctx: Ctx = { tenantId: TENANT };

function makeStore() {
  const memoryStore = new InMemoryMemoryStore();
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  return { memoryStore, lexicalStore };
}

describe("InMemoryLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951）", () => {
  it("ギリシャ語（語末までギリシャ文字）を書いて、同じ語・小文字化した語のどちらで探しても0件（実測: 本物の Postgres は両方とも0件）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, content: "ΟΔΟΣ", contentHash: "greek-exact" }),
    );

    const sameCase = await lexicalStore.search(ctx, "ΟΔΟΣ", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const lowerFinalSigma = await lexicalStore.search(ctx, "οδος", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(sameCase).toEqual([]);
    expect(lowerFinalSigma).toEqual([]);
  });

  it("本文が「100」+ ケルビン記号(U+212A)のとき、クエリ「100k」は一致しない（実測: 本物の Postgres は両 regime とも0件）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `100K`,
        contentHash: "kelvin-100k",
      }),
    );

    const hits = await lexicalStore.search(ctx, "100k", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toEqual([]);
  });

  it("同じ本文で、クエリ「100」（ASCII の連なりだけ）は一致する（実測: 本物の Postgres は両 regime とも1件）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `100K`,
        contentHash: "kelvin-100-alone",
      }),
    );

    const hits = await lexicalStore.search(ctx, "100", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
    expect(hits[0]?.coverage).toBe(1);
  });

  // ⚠ 「k」単独のクエリは Postgres の regime に依存する（確かめていないことの節を参照）。
  // UTF8 + en_US.UTF-8 では実測1件（ケルビン記号がロケール依存で `k` へ小文字化される
  // ため）だが、SQL_ASCII + C では実測0件（`C` ロケールの `lower()` は非 ASCII 文字を
  // 素通りするため、ケルビン記号は `k` に化けない）。`InMemoryLexicalStore` は
  // `String.prototype.toLowerCase()`（常に Unicode 対応、ロケール非依存）を使うため
  // UTF8 + en_US.UTF-8 側の結果と一致する——SQL_ASCII 側との不一致はこのテストの
  // 対象外（Postgres 自身の regime 間の不一致であり、Fake と Postgres の不一致ではない）。
  it("同じ本文で、クエリ「k」単独は一致する（実測: UTF8 + en_US.UTF-8 regime。SQL_ASCII + C は0件——regime 依存、確かめていないことの節参照）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `100K`,
        contentHash: "kelvin-k-alone",
      }),
    );

    const hits = await lexicalStore.search(ctx, "k", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
  });

  it("非ASCIIだけのクエリ（日本語）は0件を返す（実測: 本物の Postgres は両 regime とも0件）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "田中さんのメモ",
        contentHash: "japanese-only-content",
      }),
    );

    const hits = await lexicalStore.search(ctx, "田中", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toEqual([]);
  });
});

describe("InMemoryLexicalStore.search — 回帰しないこと（Issue #951 の修正が既存の約束を壊していないか）", () => {
  it("PROJ-1234 は大文字小文字を区別せず引ける（実測: 本物の Postgres は両 regime とも1件）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "PROJ-1234 の障害対応メモ。対応者は鈴木。",
        contentHash: "proj-1234-case",
      }),
    );

    const sameCase = await lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const lowerCase = await lexicalStore.search(ctx, "proj-1234", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(sameCase).toHaveLength(1);
    expect(sameCase[0]?.memoryId).toBe(memory.id);
    expect(lowerCase).toHaveLength(1);
    expect(lowerCase[0]?.memoryId).toBe(memory.id);
  });

  it("日本語文中の ASCII 識別子（PROJ-1234の納期、間に空白なし）が引ける（実測: 本物の Postgres は1件）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
        contentHash: "proj-1234-embedded",
      }),
    );

    const hits = await lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
    expect(hits[0]?.coverage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 確かめていないこと
// ---------------------------------------------------------------------------
//
// - 「k」単独クエリの regime 依存（上の it 内のコメント参照）。
// - ギリシャ語の語末シグマそのものの `lower()`/`toLowerCase()` の食い違いは、
//   このテストでは表面化しない（クエリが非ASCIIだけだと、シグマの違いを見る前に
//   語彙が0個になり0件になるため）。`toLowerCase()` と postgres の `lower()` が
//   全ロケール・全文字で一致する保証は無いままである
//   （`in-memory-lexical-store.ts` の doc 参照）。
// - `PostgresTrigramLexicalStore`（日本語 trigram チャンネル）との比較はしていない
//   ——本 Issue のスコープは `PostgresLexicalStore`（ASCII 語彙チャンネル）である。
