import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
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

/**
 * ADR 0630: `observe` の経路（Runtime が `NewMemory` を組み立てる）で、今まで書けていた正規の入力が、新しい入口の検査で
 * 落ちないこと。LLM が `digest` を返さない・空で返す（本文から作るフォールバック）、`claimKey` を有効にした、
 * `stated`・`inferred` の候補が、どれも書けて、読み戻した Memory が `MemorySchema` を通る。
 * 併せて、`RuntimeConfig.extractorVersion` が空文字のときの今の振る舞いを縛る（以前は書けて、`MemorySchema` を通らなかった）。
 */

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

async function build(memories: unknown[], extractorVersion?: string) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore,
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

describe("observe: RuntimeConfig.extractorVersion が空文字（今の振る舞い。ADR 0630）", () => {
  it("書けない（以前は書けて、読み戻すと MemorySchema を通らなかった）", async () => {
    await resetTestDatabase();
    const { runtime } = await build(
      [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }],
      "",
    );
    // 全候補が保存できないので、observe は最初の例外（この検査の Error）を投げる。Memory は 0 件。
    await expect(
      runtime.observe(ctx, { kind: "utterance", text: "好きな食べ物はラーメン" }),
    ).rejects.toThrow(/extractorVersion is malformed/);
    const { pool } = await getTestClient();
    const r = await pool.query("SELECT count(*)::int AS n FROM memories");
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });
});
