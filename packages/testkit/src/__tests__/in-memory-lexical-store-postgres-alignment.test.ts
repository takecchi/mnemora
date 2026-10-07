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

  // 「k」単独のクエリは Postgres の regime に依存する（UTF8 + en_US.UTF-8 では1件、SQL_ASCII + C では0件）。`InMemoryLexicalStore` は `toLowerCase()`（ロケール非依存）を使うので UTF8 側と一致する。SQL_ASCII 側との不一致は Postgres 自身の regime 間の不一致で、このテストの対象外。
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

describe("InMemoryLexicalStore.search — Unicode正規化・全角半角は一致に効かない（Issue #952、docs/recall.md §3 の表）", () => {
  const CAFE_NFC = "café";
  const CAFE_NFD = "café";

  it("café（NFC）を書き、café（NFD）で引くと一致しない（表1行目）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, content: CAFE_NFC, contentHash: "cafe-nfc-write" }),
    );

    const hits = await lexicalStore.search(ctx, CAFE_NFD, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toEqual([]);
  });

  it("全角ＡＢＣを書き、半角ABCで引くと一致しない（表2行目）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "ＡＢＣ",
        contentHash: "zenkaku-abc-write",
      }),
    );

    const hits = await lexicalStore.search(ctx, "ABC", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toEqual([]);
  });

  it("café（NFD、結合文字）を書き、cafe（無アクセントASCII）で引くと一致する（表3行目）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, content: CAFE_NFD, contentHash: "cafe-nfd-write" }),
    );

    const hits = await lexicalStore.search(ctx, "cafe", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
  });

  it("café（NFC）を書き、cafe（無アクセントASCII）で引くと一致しない（表4行目）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CAFE_NFC,
        contentHash: "cafe-nfc-vs-ascii-write",
      }),
    );

    const hits = await lexicalStore.search(ctx, "cafe", {
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
