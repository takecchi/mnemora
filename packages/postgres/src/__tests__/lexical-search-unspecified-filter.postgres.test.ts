import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `LexicalFilter` の `status` と `attributes` は、未指定（`attributes` は空オブジェクトも）なら絞り込まない。
 * 語彙一致は常に成立させ、filter を省いたときに何が返るかだけを見る。
 * trigram 版は UTF8 の `server_encoding` が前提で、満たさない環境では何もせずに戻る。
 */

const TENANT = "lexical-unspecified-filter-tenant";
const WORD_QUERY = "obsidian shards";
const WORD_CONTENT = "obsidian shards glimmer in the cave";
const TRIGRAM_QUERY = "黒曜石の欠片";
const TRIGRAM_CONTENT = "黒曜石の欠片が洞窟で光る";

type Db = Awaited<ReturnType<typeof getTestClient>>["db"];

async function seedStatuses(db: Db, content: string) {
  const memoryStore = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  const make = (status: "active" | "contested" | "archived") =>
    memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `hash-status-${status}`,
        content,
        status,
      }),
    );
  const active = await make("active");
  const archived = await make("archived");
  return { ctx, active, archived };
}

async function seedForgottenAndSuperseded(db: Db, content: string) {
  const memoryStore = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  const make = (status: "active" | "forgotten" | "superseded", supersededById?: string) =>
    memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `hash-status-${status}`,
        content,
        status,
        ...(supersededById === undefined ? {} : { supersededById }),
      }),
    );
  const active = await make("active");
  const forgotten = await make("forgotten");
  const superseded = await make("superseded", active.id);
  return { ctx, active, forgotten, superseded };
}

async function seedAttributes(db: Db, content: string) {
  const memoryStore = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  const make = (contentHash: string, attributes: Record<string, string>) =>
    memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash, content, attributes }),
    );
  const empty = await make("hash-attributes-empty", {});
  const filled = await make("hash-attributes-filled", { visibility: "internal" });
  return { ctx, empty, filled };
}

describe("LexicalStore.search — 未指定の filter は絞り込まない", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PostgresLexicalStore: filter.status を省くと、archived の記憶も返る", async () => {
    const { db } = await getTestClient();
    const { ctx, active, archived } = await seedStatuses(db, WORD_CONTENT);
    const lexicalStore = new PostgresLexicalStore(db);

    const hits = await lexicalStore.search(ctx, WORD_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((h) => h.memoryId).sort()).toEqual([active.id, archived.id].sort());
  });

  it("PostgresTrigramLexicalStore: filter.status を省くと、archived の記憶も返る", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;
    const { ctx, active, archived } = await seedStatuses(db, TRIGRAM_CONTENT);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);

    const hits = await trigramStore.search(ctx, TRIGRAM_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((h) => h.memoryId).sort()).toEqual([active.id, archived.id].sort());
  });

  it("PostgresLexicalStore: filter.status を省くと、forgotten と superseded の記憶も返る", async () => {
    const { db } = await getTestClient();
    const { ctx, active, forgotten, superseded } = await seedForgottenAndSuperseded(
      db,
      WORD_CONTENT,
    );
    const lexicalStore = new PostgresLexicalStore(db);

    const hits = await lexicalStore.search(ctx, WORD_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((h) => h.memoryId).sort()).toEqual(
      [active.id, forgotten.id, superseded.id].sort(),
    );
  });

  it("PostgresTrigramLexicalStore: filter.status を省くと、forgotten と superseded の記憶も返る", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;
    const { ctx, active, forgotten, superseded } = await seedForgottenAndSuperseded(
      db,
      TRIGRAM_CONTENT,
    );
    const trigramStore = await PostgresTrigramLexicalStore.create(db);

    const hits = await trigramStore.search(ctx, TRIGRAM_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.map((h) => h.memoryId).sort()).toEqual(
      [active.id, forgotten.id, superseded.id].sort(),
    );
  });

  it("PostgresLexicalStore: filter.attributes が空オブジェクトなら、attributes が空の記憶も空でない記憶も返る", async () => {
    const { db } = await getTestClient();
    const { ctx, empty, filled } = await seedAttributes(db, WORD_CONTENT);
    const lexicalStore = new PostgresLexicalStore(db);

    const hits = await lexicalStore.search(ctx, WORD_QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, attributes: {} },
    });

    expect(hits.map((h) => h.memoryId).sort()).toEqual([empty.id, filled.id].sort());
  });
});
