import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { sanitizeCandidateSubjectId } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0456: LLM が返した値のうち、保存の口が拒む形（NUL・孤立サロゲート）の扱いを縛る。
 *
 * - 抽出の候補の `subjectId`: 一覧（`subjectCandidates`）が無くても弾き、observation の `subjectId` へ
 *   フォールバックする。以前は保存の口が `MalformedIdentifierError` を投げ、`observe` が例外で終わった。
 * - 統合・内省の `digest`・`tags`: 保存できない値だけを落とし、統合先・内省の記憶は作る
 *   （ADR 0443 が抽出に対してやったことと同じ）。
 *
 * ここの Fake は識別子も NUL も検査しない。赤→緑は「落とした後の値」で見る（直す前は値がそのまま残る）。
 * 実 DB の歯は `packages/postgres` の `llm-malformed-aux-values.postgres.test.ts`。
 */

const NUL = "ab\u0000cd";
const LONE = "ab\ud800cd";
const SECRET = "SECRET\u0000VALUE";

describe("sanitizeCandidateSubjectId: 識別子として保存できない値は一覧が無くても弾く", () => {
  it.each([
    ["NUL", NUL],
    ["孤立サロゲート", LONE],
  ])("%s を含む subjectId は、一覧が無くても rejected になり undefined を返す", (_name, value) => {
    expect(sanitizeCandidateSubjectId(value, undefined)).toEqual({
      subjectId: undefined,
      rejected: true,
    });
    expect(sanitizeCandidateSubjectId(value, [])).toEqual({ subjectId: undefined, rejected: true });
  });

  it("一覧に同じ値があっても弾く（一覧に入れたのが呼び出し側でも、保存できない値は保存できない）", () => {
    expect(sanitizeCandidateSubjectId(NUL, [NUL])).toEqual({
      subjectId: undefined,
      rejected: true,
    });
  });

  it("陽性対照: 普通の値・絵文字（対をなすサロゲート）・null・undefined は今までどおり通る", () => {
    expect(sanitizeCandidateSubjectId("alice", undefined)).toEqual({
      subjectId: "alice",
      rejected: false,
    });
    expect(sanitizeCandidateSubjectId("a\u{1F600}b", undefined)).toEqual({
      subjectId: "a\u{1F600}b",
      rejected: false,
    });
    expect(sanitizeCandidateSubjectId(null, undefined)).toEqual({
      subjectId: null,
      rejected: false,
    });
    expect(sanitizeCandidateSubjectId(undefined, ["x"])).toEqual({
      subjectId: undefined,
      rejected: false,
    });
    expect(sanitizeCandidateSubjectId("alice", ["alice"])).toEqual({
      subjectId: "alice",
      rejected: false,
    });
  });
});

const NOW = new Date("2026-06-01T00:00:00.000Z");
function newMemory(ctx: Ctx, content: string, contentHash: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

function makeRuntime(llm: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("observe: LLM が返した subjectId が保存できない値でも、記憶は observation の subjectId で作られる", () => {
  it.each([
    ["NUL", NUL],
    ["孤立サロゲート", LONE],
  ])("%s", async (_name, bad) => {
    const llm: LLMProvider = {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) =>
        req.schema.parse({
          memories: [{ content: "猫が好き", provenanceKind: "stated", subjectId: bad }],
        }),
    };
    const { runtime, stores } = makeRuntime(llm);
    const ctx: Ctx = { tenantId: "malformed-subject" };
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      externalId: "e1",
      subjectId: "alice",
      extract: "sync",
    });
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("alice");
  });
});

describe("consolidate・reflect: LLM が返した digest・tags の保存できない値だけを落とす", () => {
  async function seedTwo(stores: ReturnType<typeof makeRuntime>["stores"], ctx: Ctx) {
    const ids: string[] = [];
    for (const k of ["a", "b"]) {
      const { memory } = await stores.memoryStore.createMemoryWithOutbox(
        ctx,
        newMemory(ctx, `猫が好き${k}`, `h-${k}`),
        [],
      );
      ids.push(memory.id);
    }
    return ids;
  }

  it("consolidate: digest の NUL はフォールバックの digest に、tags は NUL の要素だけ捨て、記憶は作る。落とした欄は created の meta に残る", async () => {
    const llm: LLMProvider = {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) =>
        req.schema.parse({ content: "統合した本文", digest: NUL, tags: [NUL, "ok"] }),
    };
    const { runtime, stores } = makeRuntime(llm);
    const ctx: Ctx = { tenantId: "cons-aux" };
    const ids = await seedTwo(stores, ctx);
    const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } as never });
    expect(result.outcome).toBe("consolidated");
    const memory = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(memory?.digest).not.toContain("\u0000");
    expect(memory?.digestSource).toBe("fallback");
    expect(memory?.tags).toEqual(["ok"]);
    const events = await stores.eventStore.list(ctx, { memoryId: memory!.id, kind: "created" });
    const dropped = (
      events[0]?.meta as { droppedFields?: Array<{ field: string; count?: number }> }
    ).droppedFields;
    expect(dropped?.map((d) => d.field).sort()).toEqual(["digest", "tags"]);
    expect(dropped?.find((d) => d.field === "tags")?.count).toBe(1);
    expect(JSON.stringify(events[0]?.meta)).not.toContain("\\u0000");
  });

  it("reflect: 同じ", async () => {
    const llm: LLMProvider = {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) =>
        req.schema.parse({
          outcome: "reflected",
          content: "一般化した本文",
          digest: NUL,
          tags: [NUL, "ok"],
        }),
    };
    const { runtime, stores } = makeRuntime(llm);
    const ctx: Ctx = { tenantId: "reflect-aux" };
    const ids = await seedTwo(stores, ctx);
    const result = await runtime.reflect(ctx, { target: { memoryIds: ids } as never });
    expect(result.outcome).toBe("reflected");
    const memory = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(memory?.digest).not.toContain("\u0000");
    expect(memory?.tags).toEqual(["ok"]);
    const events = await stores.eventStore.list(ctx, { memoryId: memory!.id, kind: "created" });
    const dropped = (events[0]?.meta as { droppedFields?: Array<{ field: string }> }).droppedFields;
    expect(dropped?.map((d) => d.field).sort()).toEqual(["digest", "tags"]);
  });

  it("droppedFields の1件ごとの中身: index は 0、contentHash は統合先・内省の本文のハッシュ、落とした値そのものは写さない", async () => {
    const cases: Array<{
      name: string;
      content: string;
      response: Record<string, unknown>;
      run: (
        runtime: ReturnType<typeof makeRuntime>["runtime"],
        ctx: Ctx,
        ids: string[],
      ) => Promise<string>;
    }> = [
      {
        name: "consolidate",
        content: "統合した本文",
        response: { content: "統合した本文", digest: SECRET, tags: [SECRET, "ok"] },
        run: async (runtime, ctx, ids) =>
          (await runtime.consolidate(ctx, { target: { memoryIds: ids } as never }))
            .consolidatedMemoryId!,
      },
      {
        name: "reflect",
        content: "一般化した本文",
        response: {
          outcome: "reflected",
          content: "一般化した本文",
          digest: SECRET,
          tags: [SECRET, "ok"],
        },
        run: async (runtime, ctx, ids) =>
          (await runtime.reflect(ctx, { target: { memoryIds: ids } as never })).reflectedMemoryId!,
      },
    ];
    for (const c of cases) {
      const llm: LLMProvider = {
        complete: async () => ({ content: "unused" }),
        completeStructured: async (_c, req) => req.schema.parse(c.response),
      };
      const { runtime, stores } = makeRuntime(llm);
      const ctx: Ctx = { tenantId: `dropped-shape-${c.name}` };
      const ids = await seedTwo(stores, ctx);
      const memoryId = await c.run(runtime, ctx, ids);
      const events = await stores.eventStore.list(ctx, { memoryId, kind: "created" });
      const meta = events[0]?.meta as { droppedFields?: unknown[] };
      expect(meta.droppedFields, c.name).toEqual([
        {
          index: 0,
          contentHash: `sha256(${c.content})`,
          field: "digest",
          reason: "nul_character",
        },
        {
          index: 0,
          contentHash: `sha256(${c.content})`,
          field: "tags",
          reason: "nul_character",
          count: 1,
          tagIndexes: [0],
        },
      ]);
      expect(JSON.stringify(meta), c.name).not.toContain("SECRET");
    }
  });

  it("陽性対照: 保存できる値だけなら、droppedFields は meta に付かず、digest と tags はそのまま", async () => {
    const llm: LLMProvider = {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) =>
        req.schema.parse({ content: "統合した本文", digest: "要約", tags: ["t1", "t2"] }),
    };
    const { runtime, stores } = makeRuntime(llm);
    const ctx: Ctx = { tenantId: "cons-aux-control" };
    const ids = await seedTwo(stores, ctx);
    const result = await runtime.consolidate(ctx, { target: { memoryIds: ids } as never });
    const memory = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(memory?.digest).toBe("要約");
    expect(memory?.tags).toEqual(["t1", "t2"]);
    const events = await stores.eventStore.list(ctx, { memoryId: memory!.id, kind: "created" });
    expect(events[0]?.meta).not.toHaveProperty("droppedFields");
  });
});
