import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import { createRuntime, ExtractionResultSchema } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 穴 O-3（ADR 0424）を `@mnemora/postgres` で縛る——core の Fake での同じ歯は
 * `packages/core/src/__tests__/claim-key-normalized-equal-not-contested.test.ts`。
 *
 * `findActiveByClaimKey?` は生の `content_hash <> …` だけで同じ内容を除くので、NFC と NFD の
 * 違いや末尾の空白1つだけで別の行として返る。`Runtime.detectClaimKeyContested` が
 * `content` を NFC + trim で比べて除く（SQL 側には入れない——`normalize()` は SQL_ASCII で使えない）。
 */

const ctx: Ctx = { tenantId: "claim-key-normalized-equal-o3" };

function sameKeyLlm(contents: string[]): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = contents[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "address" }] });
    },
  };
}

afterAll(async () => {
  await closeTestClient();
});

async function observeTwice(first: string, second: string) {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: sameKeyLlm([first, second]),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
  });
  const opts = { claimKey: { enabled: true, detectContested: true } } as const;
  const a = await runtime.observe(ctx, { kind: "utterance", text: "first", ...opts });
  const b = await runtime.observe(ctx, { kind: "utterance", text: "second", ...opts });
  const memA = await memoryStore.get(ctx, a.memoryIds[0]!);
  const memB = await memoryStore.get(ctx, b.memoryIds[0]!);
  return { b, memA, memB };
}

describe("claim key の検出: 正規化すると同じ content は互いに contested にならない（穴 O-3、ADR 0424。@mnemora/postgres）", () => {
  it("NFC と NFD だけが違う同じ文は contested にならない（保存値は変わらない）", async () => {
    const nfc = "私が東京に住んでいる";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    const { b, memA, memB } = await observeTwice(nfc, nfd);
    expect(b.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    expect(memA?.status).toBe("active");
    expect(memB?.status).toBe("active");
    expect(memA?.content).toBe(nfc);
    expect(memB?.content).toBe(nfd);
  });

  it("末尾の空白1つだけが違う同じ文は contested にならない", async () => {
    const { b, memA, memB } = await observeTwice("住所は東京", "住所は東京 ");
    expect(b.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    expect(memA?.status).toBe("active");
    expect(memB?.status).toBe("active");
  });

  it("陽性対照: 本当に違う文は今までどおり contested になる", async () => {
    const { b, memA, memB } = await observeTwice("住所は東京", "住所は大阪");
    expect(b.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested" }),
      }),
    ]);
    expect(memA?.status).toBe("contested");
    expect(memB?.status).toBe("contested");
  });
});
