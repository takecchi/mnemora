import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresTrigramLexicalStore.search` の `filter.subjectId` × `filter.includeSubjectless`
 * （`docs/recall.md`「includeSubjectless」節・ADR 0286）の実測。
 *
 * 約束: `subjectId` を指定すると `subject_id = X`、`includeSubjectless: true` なら
 * `subject_id = X OR subject_id IS NULL`——**どちらでも X 以外の別 subject は混ざらない**。
 * `subjectId` を省略した呼び出しでは `includeSubjectless` は無視される（テナント全体）。
 *
 * 語彙の既定経路（`PostgresLexicalStore`）は `lexical-store-filter.test.ts` と共有の
 * 適合テストが押さえているが、trigram 経路（opt-in）は適合テストを通しておらず、この
 * 組み合わせを押さえる歯が無かった。**`*-conformance.ts` には足さない**（外部 adapter
 * への要件を増やさないため、Issue #809 の方針）。
 *
 * **⚠ この歯は UTF8 の `server_encoding` を前提とする**（ADR 0103 の規律。
 * `trigram-lexical-store-query-word-cap.test.ts` と同じ測り方）。前提を満たさない環境では
 * 何もせずに戻る——`PostgresTrigramLexicalStore.create` が投げることは
 * `trigram-lexical-store.postgres.test.ts` が検査している。
 */

const TENANT = "trigram-subject-tenant";
const QUERY = "主題境界プローブ";

async function seed(db: Parameters<typeof PostgresTrigramLexicalStore.create>[0]) {
  const memoryStore = new PostgresMemoryStore(db);
  const ctx: Ctx = { tenantId: TENANT };
  const make = (contentHash: string, subjectId: string | null) =>
    memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash,
        subjectId,
        content: `${QUERY}の記憶（${contentHash}）`,
      }),
    );
  const a = await make("trigram-subject-a", "subject-a");
  const b = await make("trigram-subject-b", "subject-b");
  const none = await make("trigram-subject-null", null);
  return { ctx, a, b, none };
}

describe("PostgresTrigramLexicalStore.search: subjectId × includeSubjectless（ADR 0286）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("subjectId だけを指定すると、その subject の記憶だけが返る（別 subject も subjectless も返らない）", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;

    const { ctx, a, b, none } = await seed(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    for (const includeSubjectless of [undefined, false] as const) {
      const hits = await trigramStore.search(ctx, QUERY, {
        limit: 50,
        filter: { tenantId: TENANT, subjectId: "subject-a", includeSubjectless },
      });
      const ids = hits.map((h) => h.memoryId);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(b.id);
      expect(ids).not.toContain(none.id);
    }
  });

  it("includeSubjectless: true では、その subject と subjectless の記憶が返り、別 subject は返らない", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;

    const { ctx, a, b, none } = await seed(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const hits = await trigramStore.search(ctx, QUERY, {
      limit: 50,
      filter: { tenantId: TENANT, subjectId: "subject-a", includeSubjectless: true },
    });
    const ids = hits.map((h) => h.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(none.id);
    expect(ids).not.toContain(b.id);
  });

  it("subjectId を省略すると includeSubjectless に関わらずテナント全体が返る", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;

    const { ctx, a, b, none } = await seed(db);
    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    for (const includeSubjectless of [undefined, true] as const) {
      const hits = await trigramStore.search(ctx, QUERY, {
        limit: 50,
        filter: { tenantId: TENANT, includeSubjectless },
      });
      expect(hits.map((h) => h.memoryId).sort()).toEqual([a.id, b.id, none.id].sort());
    }
  });
});
