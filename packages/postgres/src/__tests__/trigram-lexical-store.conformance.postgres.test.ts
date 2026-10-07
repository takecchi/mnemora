import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach } from "vitest";
import {
  buildNewMemoryFixture,
  buildProvenanceFixture,
  describeLexicalStoreConformance,
} from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `packages/testkit` の `LexicalStore` 適合テスト一式を、語彙の trigram 経路
 * （`PostgresTrigramLexicalStore`、opt-in）にも当てる。**一式には要件を1つも足さない**——
 * 既存の一式を、もう1つの adapter に通すだけである。
 *
 * **⚠ UTF8 の `server_encoding` を前提とする。**前提を満たさない環境では各項目を skip する——
 * `PostgresTrigramLexicalStore.create` が投げることは `trigram-lexical-store.postgres.test.ts` が検査している。
 */

beforeEach(async (context) => {
  const { db } = await getTestClient();
  const probe = await probeTrigramLexicalSupport(db);
  if (!probe.ok) context.skip();
});

describeLexicalStoreConformance({
  name: "postgres (trigram)",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return PostgresTrigramLexicalStore.create(db);
  },
  prepareMemory: async (ctx: Ctx, attrs) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: attrs.content,
        ...(attrs.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
        ...(attrs.validFrom !== undefined ? { validFrom: attrs.validFrom } : {}),
        ...(attrs.validUntil !== undefined ? { validUntil: attrs.validUntil } : {}),
        ...(attrs.attributes !== undefined ? { attributes: attrs.attributes } : {}),
        ...(attrs.tags !== undefined ? { tags: attrs.tags } : {}),
      }),
    );
    return memory.id;
  },
});

afterAll(async () => {
  await closeTestClient();
});
