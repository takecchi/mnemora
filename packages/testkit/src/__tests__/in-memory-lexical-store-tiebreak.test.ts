import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "lexical-search-tiebreak-tenant";
// content は ASCII にする。非 ASCII だけのクエリは Postgres と同じく常に0件になり、tie-break を見られない。
const CONTENT = "widget alpha bravo tie-break test content";

describe("InMemoryLexicalStore.search — coverage/rank が完全一致したときの tie-break（LexicalStore.search doc / ADR 0175）", () => {
  it("recorded_at が新しい方を先に返す（PostgresLexicalStore.search と同じ契約）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-older",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-newer",
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );

    const hits = await lexicalStore.search(ctx, CONTENT, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);
    expect(hits[0]!.memoryId).toBe(newer.id);
    expect(hits[1]!.memoryId).toBe(older.id);
  });

  it("recorded_at まで完全一致したら memory_id 昇順にフォールバックする（欠落・重複が無い）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");

    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-a",
        recordedAt: sameRecordedAt,
      }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-b",
        recordedAt: sameRecordedAt,
      }),
    );

    const hits = await lexicalStore.search(ctx, CONTENT, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set([a.id, b.id]));
    const [smaller, larger] = [a.id, b.id].sort();
    expect(hits[0]!.memoryId).toBe(smaller);
    expect(hits[1]!.memoryId).toBe(larger);
  });
});
