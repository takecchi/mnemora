import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, DeterministicEmbeddingProvider } from "@mnemora/testkit";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0456（ADR 0443 の続き）: LLM が返した値のうち、Postgres が保存できない形（NUL・孤立サロゲート）のものを、
 * 実 DB で縛る。
 *
 * - 抽出の候補の `subjectId`（`subjectCandidates` を渡さない経路）: 直す前は `createMemoryWithOutbox` が
 *   `MalformedIdentifierError` を投げ、`observe`（同期の抽出）が例外で終わった（observation は残り、記憶は0件）。
 * - 統合・内省の `digest`・`tags`: 直す前は `DrizzleQueryError`（`invalid byte sequence … 0x00`）で例外になった
 *   （統合元・内省の材料は active のまま）。
 */

const NUL = "ab\u0000cd";
const LONE = "ab\ud800cd";
const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");

let extractReturn: Record<string, unknown> = {};
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (req.prompt.system?.includes("claim key")) {
      return req.schema.parse({ claims: [{ subject: "user", predicate: "likes" }] });
    }
    return req.schema.parse(extractReturn);
  },
};

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function setup(opts: { acceptLlmSubjectId?: boolean } = {}) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const eventStore = new PostgresEventStore(db);
  const now = new Date(Date.now() + 86_400_000);
  const runtime: Runtime = createRuntime({
    memoryStore,
    eventStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    lexicalStore: new PostgresLexicalStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: llm,
    embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
    hashContent,
    clock: { now: () => now },
    // 問15: LLM の subjectId は既定で捨てられる。ADR 0456 の「保存できない値を弾く」歯を保つため、受ける側で当てる。
    ...(opts.acceptLlmSubjectId ? { config: { acceptLlmSubjectIdWithoutCandidates: true } } : {}),
  });
  return { runtime, memoryStore, eventStore, now };
}

describe("observe: LLM が返した subjectId が保存できない値", () => {
  it.each([
    ["NUL", NUL],
    ["孤立サロゲート", LONE],
  ])("%s: 例外にならず、記憶は observation の subjectId で作られる", async (_name, bad) => {
    const { runtime, memoryStore } = await setup({ acceptLlmSubjectId: true });
    const ctx: Ctx = { tenantId: `malformed-subject-${_name}` };
    extractReturn = {
      memories: [{ content: "猫が好き", provenanceKind: "stated", subjectId: bad }],
    };
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      externalId: "e1",
      subjectId: "alice",
      extract: "sync",
    });
    expect(result.memoryIds).toHaveLength(1);
    const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("alice");
  });

  it("陽性対照: 保存できる subjectId はそのまま使われる", async () => {
    const { runtime, memoryStore } = await setup();
    const ctx: Ctx = { tenantId: "malformed-subject-control" };
    extractReturn = {
      memories: [{ content: "猫が好き", provenanceKind: "stated", subjectId: "bob" }],
    };
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      externalId: "e1",
      subjectId: "alice",
      // 問15: 一覧が無いと LLM の subjectId は既定で捨てられる。一覧に入れた保存できる値は、そのまま使われる。
      subjectCandidates: ["bob"],
      extract: "sync",
    });
    expect((await memoryStore.get(ctx, result.memoryIds[0]!))?.subjectId).toBe("bob");
  });
});

describe("consolidate・reflect: LLM が返した digest・tags が保存できない値", () => {
  async function seedTwo(ctx: Ctx, memoryStore: PostgresMemoryStore, now: Date) {
    const ids: string[] = [];
    for (const k of ["a", "b"]) {
      const { memory } = await memoryStore.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: `猫が好き${k}`,
          digest: `猫${k}`,
          contentHash: `h-${k}`,
          recordedAt: now,
        }),
        [],
      );
      ids.push(memory.id);
    }
    return ids;
  }

  it("consolidate: 例外にならず、digest はフォールバック・tags は NUL の要素だけ捨てて作る。統合元は superseded", async () => {
    const { runtime, memoryStore, eventStore, now } = await setup();
    const ctx: Ctx = { tenantId: "cons-aux-pg" };
    const ids = await seedTwo(ctx, memoryStore, now);
    extractReturn = { content: "統合した本文", digest: NUL, tags: [NUL, "ok"] };
    const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
    expect(result.outcome).toBe("consolidated");
    const memory = await memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(memory?.digestSource).toBe("fallback");
    expect(memory?.tags).toEqual(["ok"]);
    expect((await memoryStore.getMany(ctx, ids)).map((m) => m.status)).toEqual([
      "superseded",
      "superseded",
    ]);
    const created = await eventStore.list(ctx, { memoryId: memory!.id, kind: "created" });
    const dropped = (created[0]?.meta as { droppedFields?: Array<{ field: string }> })
      .droppedFields;
    expect(dropped?.map((d) => d.field).sort()).toEqual(["digest", "tags"]);
  });

  it("reflect: 同じ。材料は active のまま", async () => {
    const { runtime, memoryStore, eventStore, now } = await setup();
    const ctx: Ctx = { tenantId: "reflect-aux-pg" };
    const ids = await seedTwo(ctx, memoryStore, now);
    extractReturn = {
      outcome: "reflected",
      content: "一般化した本文",
      digest: NUL,
      tags: [NUL, "ok"],
    };
    const result = await runtime.reflect(ctx, { target: { memoryIds: ids } });
    expect(result.outcome).toBe("reflected");
    const memory = await memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(memory?.digestSource).toBe("fallback");
    expect(memory?.tags).toEqual(["ok"]);
    expect((await memoryStore.getMany(ctx, ids)).map((m) => m.status)).toEqual([
      "active",
      "active",
    ]);
    const created = await eventStore.list(ctx, { memoryId: memory!.id, kind: "created" });
    const dropped = (created[0]?.meta as { droppedFields?: Array<{ field: string }> })
      .droppedFields;
    expect(dropped?.map((d) => d.field).sort()).toEqual(["digest", "tags"]);
  });

  it("陽性対照: 保存できる digest・tags はそのまま保存され、droppedFields は付かない", async () => {
    const { runtime, memoryStore, eventStore, now } = await setup();
    const ctx: Ctx = { tenantId: "cons-aux-pg-control" };
    const ids = await seedTwo(ctx, memoryStore, now);
    extractReturn = { content: "統合した本文", digest: "要約", tags: ["t1"] };
    const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
    const memory = await memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(memory?.digest).toBe("要約");
    expect(memory?.tags).toEqual(["t1"]);
    const created = await eventStore.list(ctx, { memoryId: memory!.id, kind: "created" });
    expect(created[0]?.meta).not.toHaveProperty("droppedFields");
  });
});
