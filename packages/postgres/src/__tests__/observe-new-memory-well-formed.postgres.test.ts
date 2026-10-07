import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, StructuredRequest } from "@mnemora/core";
import { createRuntime, ExtractionResultSchema, MemorySchema } from "@mnemora/core";
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

const ctx: Ctx = { tenantId: "observe-well-formed" };

function llm(memories: unknown[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        return req.schema.parse({ memories });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "favorite_food" }] });
    },
  };
}

const BAD = "壊れる候補";

/**
 * 本文が {@link BAD} の候補だけ、store へ渡す前に `digest` を空文字にする（Runtime が作る `NewMemory` では、
 * digest は本文から補われるので、壊れた候補は自然には作れない）。
 */
function corrupting(inner: PostgresMemoryStore): MemoryStore {
  return new Proxy(inner as MemoryStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "createMemoriesWithOutboxAndEvents") {
        return (
          ...args: Parameters<NonNullable<MemoryStore["createMemoriesWithOutboxAndEvents"]>>
        ) => {
          const [c, news, ...rest] = args;
          const next = news.map((entry) =>
            entry.input.content === BAD
              ? { ...entry, input: { ...entry.input, digest: "" } }
              : entry,
          );
          return (value as NonNullable<MemoryStore["createMemoriesWithOutboxAndEvents"]>).call(
            target,
            c,
            next,
            ...rest,
          );
        };
      }
      return value.bind(target);
    },
  });
}

async function build(memories: unknown[], extractorVersion?: string, corrupt = false) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore: corrupt ? corrupting(memoryStore) : memoryStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: llm(memories),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    ...(extractorVersion === undefined ? {} : { config: { extractorVersion } }),
  });
  return { memoryStore, runtime };
}

afterAll(async () => {
  await closeTestClient();
});

describe("observe: 正規の入力は、入口の検査（ADR 0630）で落ちず、読み戻した Memory は MemorySchema を通る", () => {
  it.each([
    [
      "digest が無い（本文から作る）",
      [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }],
    ],
    [
      "digest が空白だけ",
      [{ content: "好きな食べ物はラーメン", digest: "  ", provenanceKind: "stated" }],
    ],
    [
      "digest が有る",
      [{ content: "好きな食べ物はラーメン", digest: "ラーメン好き", provenanceKind: "stated" }],
    ],
    ["inferred", [{ content: "辛いものが好きかもしれない", provenanceKind: "inferred" }]],
  ])("%s（claimKey 有効）", async (_label, memories) => {
    await resetTestDatabase();
    const { memoryStore, runtime } = await build(memories);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true },
    });
    expect(result.memoryIds).toHaveLength(1);
    const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
    expect(MemorySchema.safeParse(memory).success).toBe(true);
  });
});

describe("RuntimeConfig.extractorVersion が空文字（ADR 0630）", () => {
  it("createRuntime が組み立ての時点で投げる（以前は書けて、読み戻すと MemorySchema を通らなかった）", async () => {
    await expect(
      build([{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }], ""),
    ).rejects.toThrow(/extractorVersion must not be empty or whitespace-only/);
  });
});

describe("observe: 壊れた候補を含む抽出結果（ADR 0630）", () => {
  it("壊れた候補だけを落として残りを書き、observe は投げない。落とした候補は created の meta に残る", async () => {
    await resetTestDatabase();
    const { memoryStore, runtime } = await build(
      [
        { content: "一件目の事実", provenanceKind: "stated" },
        { content: BAD, provenanceKind: "stated" },
        { content: "三件目の事実", provenanceKind: "stated" },
      ],
      undefined,
      true,
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(2);
    const written = await memoryStore.listBySourceObservationAllVersions(ctx, result.observationId);
    expect(written.map((m) => m.content).sort()).toEqual(["一件目の事実", "三件目の事実"]);
    for (const m of written) expect(MemorySchema.safeParse(m).success).toBe(true);
    const { pool } = await getTestClient();
    const events = await pool.query(
      "SELECT meta FROM memory_events WHERE kind = 'created' ORDER BY id",
    );
    expect(events.rows).toHaveLength(2);
    for (const row of events.rows as Array<{
      meta: { droppedCandidates?: Array<{ index: number; message: string }> };
    }>) {
      expect(row.meta.droppedCandidates).toHaveLength(1);
      expect(row.meta.droppedCandidates![0]).toMatchObject({ index: 1 });
      expect(row.meta.droppedCandidates![0]!.message).toMatch(/digest is malformed/);
    }
  });

  it("全件が壊れていれば、observe は最初の例外のまま投げ、何も書かない", async () => {
    await resetTestDatabase();
    const { runtime } = await build([{ content: BAD, provenanceKind: "stated" }], undefined, true);
    await expect(runtime.observe(ctx, { kind: "utterance", text: "発話" })).rejects.toThrow(
      /digest is malformed/,
    );
    const { pool } = await getTestClient();
    const r = await pool.query("SELECT count(*)::int AS n FROM memories");
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });
});
