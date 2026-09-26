// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #951: `FakeLexicalStore`（このファイルが検査する fake）と
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
// これに加えて `FakeLexicalStore` は元々 `String.prototype.includes()`（大文字小文字を
// 区別する部分文字列一致）を使っており、`PostgresLexicalStore`/`to_tsvector('simple', …)`
// の大文字小文字を区別しない判定とも食い違っていた——この歯はその回帰確認も兼ねる。
//
// 期待値はすべて、本物の Postgres 17.11（pgvector 0.8.0）に対し
// `PostgresLexicalStore.search` を実際に呼んで実測した値である——CI の2 regime
// （UTF8 + en_US.UTF-8、SQL_ASCII + C）の両方で同じ結果になることを確認済み
// （下の各 it のコメント参照。「確かめていないこと」は末尾にまとめる）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-postgres-alignment-tenant" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 365 * 5),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951）", () => {
  it("ギリシャ語（語末までギリシャ文字）を書いて、同じ語・小文字化した語のどちらで探しても0件（実測: 本物の Postgres は両方とも0件）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "ΟΔΟΣ", contentHash: "greek-exact" }),
    );

    const sameCase = await stores.lexicalStore.search(ctx, "ΟΔΟΣ", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const lowerFinalSigma = await stores.lexicalStore.search(ctx, "οδος", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(sameCase).toEqual([]);
    expect(lowerFinalSigma).toEqual([]);
  });

  it("本文が「100」+ ケルビン記号(U+212A)のとき、クエリ「100k」は一致しない（実測: 本物の Postgres は両 regime とも0件）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `100K`, contentHash: "kelvin-100k" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "100k", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toEqual([]);
  });

  it("同じ本文で、クエリ「100」（ASCII の連なりだけ）は一致する（実測: 本物の Postgres は両 regime とも1件）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `100K`, contentHash: "kelvin-100-alone" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "100", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
    expect(hits[0]?.coverage).toBe(1);
  });

  // ⚠ 「k」単独のクエリは Postgres の regime に依存する（確かめていないことの節を参照）。
  // UTF8 + en_US.UTF-8 では実測1件（ケルビン記号がロケール依存で `k` へ小文字化される
  // ため）だが、SQL_ASCII + C では実測0件（`C` ロケールの `lower()` は非 ASCII 文字を
  // 素通りするため、ケルビン記号は `k` に化けない）。`FakeLexicalStore` は
  // `String.prototype.toLowerCase()`（常に Unicode 対応、ロケール非依存）を使うため
  // UTF8 + en_US.UTF-8 側の結果と一致する——SQL_ASCII 側との不一致はこのテストの
  // 対象外（Postgres 自身の regime 間の不一致であり、Fake と Postgres の不一致ではない）。
  it("同じ本文で、クエリ「k」単独は一致する（実測: UTF8 + en_US.UTF-8 regime。SQL_ASCII + C は0件——regime 依存、確かめていないことの節参照）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `100K`, contentHash: "kelvin-k-alone" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "k", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
  });

  it("非ASCIIだけのクエリ（日本語）は0件を返す（実測: 本物の Postgres は両 regime とも0件）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "田中さんのメモ", contentHash: "japanese-only-content" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "田中", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toEqual([]);
  });
});

describe("FakeLexicalStore.search — 回帰しないこと（Issue #951 の修正が既存の約束を壊していないか）", () => {
  it("PROJ-1234 は大文字小文字を区別せず引ける（実測: 本物の Postgres は両 regime とも1件。以前は FakeLexicalStore に大文字小文字の区別が残っていた）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "PROJ-1234 の障害対応メモ。対応者は鈴木。",
        contentHash: "proj-1234-case",
      }),
    );

    const sameCase = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const lowerCase = await stores.lexicalStore.search(ctx, "proj-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(sameCase).toHaveLength(1);
    expect(sameCase[0]?.memoryId).toBe(memory.id);
    expect(lowerCase).toHaveLength(1);
    expect(lowerCase[0]?.memoryId).toBe(memory.id);
  });

  it("日本語文中の ASCII 識別子（PROJ-1234の納期、間に空白なし）が引ける（実測: 本物の Postgres は1件）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
        contentHash: "proj-1234-embedded",
      }),
    );

    const hits = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
    expect(hits[0]?.coverage).toBe(1);
  });

  it("偽陽性の点検: 似た接頭辞の識別子（PROJ-5678）は誤爆しない（実測: 本物の Postgres も一致しない。websearch_to_tsquery のフレーズ隣接演算子と同じ結果——FakeLexicalStore はクエリを空白区切りの1語のまま部分文字列一致するため、たまたま同じ結果になる）", async () => {
    const stores = createFakeRuntimeStores();
    const gold = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "PROJ-1234 の障害対応メモ。対応者は鈴木。",
        contentHash: "proj-1234-gold",
      }),
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "PROJ-5678 の障害対応メモ。対応者は山田。",
        contentHash: "proj-5678-decoy",
      }),
    );

    const hits = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits.map((h) => h.memoryId)).toEqual([gold.id]);
  });
});

// ---------------------------------------------------------------------------
// 確かめていないこと
// ---------------------------------------------------------------------------
//
// - 「k」単独クエリの regime 依存（上の it 内のコメント参照）。
// - ギリシャ語の語末シグマそのものの `lower()`/`toLowerCase()` の食い違いは、
//   このテストでは表面化しない（クエリが非ASCIIだけだと、シグマの違いを見る前に
//   語彙が0個になり0件になるため）。
// - `FakeLexicalStore` の識別子の隣接性（`PROJ-1234` を割らずに1語として扱う）は、
//   意図した設計ではなく「空白区切りでしか割らない」実装のたまたまの結果である
//   （`FakeLexicalStore` の doc 参照）——`PROJ-1234 and TASK-5678` のように2つの
//   識別子が空白区切りで並ぶ本文に対して `PROJ-5678` を投げた場合の偽陽性の有無は、
//   ここでは確認していない（`packages/postgres` の
//   `lexical-store-identifier.test.ts` が postgres 側でこの形を検査している）。
