import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { deriveClaimKeys } from "../claim-key.js";
import { ExtractionResultSchema } from "../extraction.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0433 決定1: 正規化のあとで長さが上限（コードポイント256）を超えた subject・predicate は、
 * 鍵が取れなかったものとして `null` にする（空白だけの要素と同じ扱い）。
 *
 * Postgres の `idx_memories_claim_key`（btree）は1行 2704 バイトを超えると INSERT が落ちるので、
 * 偽の LLM が長い値を返しても `observe` が成功することを縛る。
 * Postgres 側の同じ歯は `packages/postgres/src/__tests__/claim-key-oversized-part.postgres.test.ts`。
 */

const ctx: Ctx = { tenantId: "tenant-oversized-claim-key" };
const LIMIT = 256;

function llmReturning(response: unknown): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(response) as T,
  };
}

describe("deriveClaimKeys: 長さの上限（ADR 0433 決定1）", () => {
  it("上限ちょうど（256コードポイント）は通り、257 は null になる。subject・predicate のどちらが超えても null", async () => {
    const provider = llmReturning({
      claims: [
        { subject: "u".repeat(LIMIT), predicate: "p".repeat(LIMIT) },
        { subject: "u".repeat(LIMIT + 1), predicate: "favorite_food" },
        { subject: "user", predicate: "p".repeat(LIMIT + 1) },
        { subject: "user", predicate: "favorite_food" },
      ],
    });
    const result = await deriveClaimKeys(provider, ctx, ["a", "b", "c", "d"]);
    expect(result.claimKeys).toEqual([
      { subject: "u".repeat(LIMIT), predicate: "p".repeat(LIMIT) },
      null,
      null,
      { subject: "user", predicate: "favorite_food" },
    ]);
    expect(result.failure).toBeNull();
  });

  it("数えるのはコードポイント（サロゲートペアを1文字と数える）。正規化のあとの長さで測る", async () => {
    const astral = "\u{1F600}"; // UTF-16 で2単位、UTF-8 で4バイト
    const provider = llmReturning({
      claims: [
        { subject: "user", predicate: astral.repeat(LIMIT) },
        { subject: "user", predicate: astral.repeat(LIMIT + 1) },
        // NFKC で "ﬃ" は 3 文字に伸びる: 元は 86 文字、正規化後は 258 文字（上限超え）
        { subject: "user", predicate: "ﬃ".repeat(86) },
      ],
    });
    const result = await deriveClaimKeys(provider, ctx, ["a", "b", "c"]);
    expect(result.claimKeys).toEqual([
      { subject: "user", predicate: astral.repeat(LIMIT) },
      null,
      null,
    ]);
  });
});

describe("observe(claimKey: { enabled: true }): 長い predicate を返す偽の LLM でも成功する（ADR 0433）", () => {
  it("記憶は作られ、鍵は null になる", async () => {
    const stores = createFakeRuntimeStores();
    const llm: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        if ((req.schema as unknown) === ExtractionResultSchema) {
          return req.schema.parse({
            memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }],
          });
        }
        return req.schema.parse({
          claims: [{ subject: "s".repeat(3200), predicate: "ab".repeat(1600) }],
        });
      },
    };
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true },
    });
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.claimKey ?? null).toBeNull();
  });
});
