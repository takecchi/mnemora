import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, VectorFilter } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createRuntime, isEmbeddingSpaceNotRegisteredError } from "@mnemora/core";
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
 * 利用者へ伝わる例外の message から、SQL に付けた値（params）を落とす（ADR 0423。ADR 0363 と同じ作法）。
 *
 * 本物の drizzle が包んだ例外（`Failed query: <SQL>\nparams: <値>`）で見る。本文に値を入れた入力で
 * 例外を起こし、message に本文が入らないこと、SQL の文・`cause` の理由と SQLSTATE が残ることを確かめる。
 * 例外の起こし方は、jsonb 列が受けない値（孤立サロゲート）を本文に入れること——本文そのものの扱いは変えない。
 */

const ctx: Ctx = { tenantId: "error-message-omits-params" };
const BODY_MARKER = "本文の目印-0123456789";
const BAD_BODY = `${BODY_MARKER}\uD83D`;

afterAll(async () => {
  await closeTestClient();
});

async function buildRuntime() {
  const { db } = await getTestClient();
  return createRuntime({
    memoryStore: new PostgresMemoryStore(db),
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: {
      complete: async () => ({ content: "unused" }),
      completeStructured: async () => {
        throw new Error("not reached");
      },
    },
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("reject しなかった");
}

describe("runtime.observe の例外の message に、本文は入らない", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("SQL の文と cause（pg の理由と SQLSTATE）は残り、params の値は message にも stack にも無い", async () => {
    const runtime = await buildRuntime();
    const error = await thrown(runtime.observe(ctx, { kind: "utterance", text: BAD_BODY }));

    expect(error.message).toContain("Failed query:");
    expect(error.message).toContain("observations");
    expect(error.message).not.toContain(BODY_MARKER);
    expect(String(error.stack)).not.toContain(BODY_MARKER);
    const cause = error.cause as { message?: string; code?: string } | undefined;
    expect(cause?.code).toBe("22P02");
    expect(cause?.message).toMatch(/invalid input syntax for type json/);
  });
});

/**
 * ADR 0504: store を直接呼んだときも、投げる例外の message（`cause` の連鎖を含む）から params の値を落とす。
 * `PostgresVectorStore` の全ての口。`searchMany` は 1 文に最大 16384 件のベクトルが params に載る。
 * 例外の起こし方は2つ: (a) 登録していない空間（42P01 を `EmbeddingSpaceNotRegisteredError` に包む経路）、
 * (b) 登録済みの空間への次元違いの `upsert`（pgvector が拒む。包まずそのまま投げる経路）。
 * `deleteAcrossSpaces`・`eraseTenant` は本物の DB では起こしにくいので、drizzle 形の例外を投げる db で見る。
 */
const VECTOR_MARKER = "0.7312345";
const TENANT_MARKER = "tenant-marker-4d1f";
const storeCtx: Ctx = { tenantId: `omit-params-${TENANT_MARKER}` };
const UNREGISTERED: EmbeddingSpaceId = {
  provider: "test",
  model: "never-registered",
  dimensions: 3,
};
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const FILTER: VectorFilter = { tenantId: storeCtx.tenantId, status: ["active"] };

function chainTexts(error: unknown): string[] {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { message, stack, cause } = current as {
      message?: unknown;
      stack?: unknown;
      cause?: unknown;
    };
    texts.push(String(message), String(stack));
    current = cause;
  }
  return texts;
}

function expectNoParams(error: unknown): void {
  const texts = chainTexts(error);
  for (const text of texts) {
    expect(text).not.toContain(VECTOR_MARKER);
    expect(text).not.toContain(TENANT_MARKER);
  }
  // やりすぎていない: SQL の文と、落としたことの印は残る
  expect(texts.some((t) => t.includes("Failed query:") && t.includes("(omitted by mnemora,"))).toBe(
    true,
  );
}

describe("PostgresVectorStore を直接呼んだ例外から、params の値を落とす（ADR 0504）", () => {
  const mouths: Array<[string, (store: PostgresVectorStore) => Promise<unknown>]> = [
    ["upsert", (s) => s.upsert(storeCtx, UNREGISTERED, MEMORY_ID, [0.7312345, 0, 0])],
    [
      "search",
      (s) => s.search(storeCtx, UNREGISTERED, [0.7312345, 0, 0], { limit: 5, filter: FILTER }),
    ],
    [
      "searchMany",
      (s) =>
        s.searchMany(storeCtx, UNREGISTERED, [{ key: "a", vector: [0.7312345, 0, 0] }], {
          limit: 5,
          filter: FILTER,
        }),
    ],
    ["delete", (s) => s.delete(storeCtx, UNREGISTERED, MEMORY_ID)],
    ["getVectors", (s) => s.getVectors(storeCtx, UNREGISTERED, [MEMORY_ID])],
  ];

  for (const [name, run] of mouths) {
    it(`${name}（未登録の空間）: cause の連鎖に params の値が無く、kind・SQLSTATE は残る`, async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const error = await thrown(run(new PostgresVectorStore(db)));
      expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(true);
      expect((error as { kind?: string }).kind).toBe("embedding_space_not_registered");
      expectNoParams(error);
      let code: unknown;
      let cursor: unknown = (error as Error).cause;
      while (typeof cursor === "object" && cursor !== null) {
        code = (cursor as { code?: unknown }).code ?? code;
        cursor = (cursor as { cause?: unknown }).cause;
      }
      expect(code).toBe("42P01");
    });
  }

  it("upsert（登録済みの空間への次元違い。包まずそのまま投げる経路）: message に params の値が無く、原因は残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memory = await new PostgresMemoryStore(db).createMemory(
      storeCtx,
      buildNewMemoryFixture({ tenantId: storeCtx.tenantId, contentHash: "omit-params-0504" }),
    );
    const error = await thrown(
      new PostgresVectorStore(db).upsert(storeCtx, TEST_EMBEDDING_SPACE, memory.id, [0.7312345, 0]),
    );
    expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(false);
    expectNoParams(error);
    expect(chainTexts(error).join("\n")).toMatch(/expected 3 dimensions, not 2/);
  });

  for (const [name, run] of [
    ["deleteAcrossSpaces", (s: PostgresVectorStore) => s.deleteAcrossSpaces(storeCtx, [MEMORY_ID])],
    ["eraseTenant", (s: PostgresVectorStore) => s.eraseTenant(storeCtx, { limit: 10 })],
  ] as const) {
    it(`${name}: トランザクションが投げた drizzle 形の例外から params の値を落とす`, async () => {
      const drizzleLike = Object.assign(
        new Error(
          `Failed query: DELETE FROM t WHERE tenant_id = $1\nparams: ${storeCtx.tenantId},[${VECTOR_MARKER}]`,
        ),
        { cause: Object.assign(new Error("boom"), { code: "57014" }) },
      );
      const failing = {
        transaction: async () => {
          throw drizzleLike;
        },
      } as unknown as ConstructorParameters<typeof PostgresVectorStore>[0];
      const error = await thrown(run(new PostgresVectorStore(failing)));
      expect(error).toBe(drizzleLike);
      expectNoParams(error);
      expect((drizzleLike.cause as { code?: string }).code).toBe("57014");
    });
  }
});
