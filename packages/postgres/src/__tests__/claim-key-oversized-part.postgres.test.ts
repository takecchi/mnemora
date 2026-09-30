import { createHash } from "node:crypto";
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
 * ADR 0433 決定1: 偽の LLM が btree の1行の上限（2704 バイト）を超える長さの subject・predicate を
 * 返しても、`observe(... claimKey: { enabled: true })` が成功し、鍵は `null` になる。
 *
 * 直す前は `INSERT INTO memories` が `index row size ... exceeds btree version 4 maximum 2704 for
 * index "idx_memories_claim_key"` で落ち、observation だけが残って memory は 0 件だった。
 * core の Fake での同じ歯は `packages/core/src/__tests__/claim-key-oversized-part.test.ts`。
 *
 * 上限ちょうど（256 コードポイント × 4 バイト文字を subject と predicate の両方に）が、
 * 長い tenant_id・subject_id と一緒でも INSERT できることも縛る（上限の根拠のバイト見積もり）。
 */

const ctx: Ctx = { tenantId: "claim-key-oversized" };

/** CJK 統合漢字拡張 B（U+20000 台、UTF-8 で 4 バイト、NFKC で変わらない）の疑似乱数の文字列。 */
function astralNoise(seed: string, chars: number): string {
  const bytes = createHash("sha256").update(seed).digest();
  let out = "";
  let digest = bytes;
  for (let i = 0; i < chars; i++) {
    if (i > 0 && i % 16 === 0) {
      digest = createHash("sha256").update(digest).digest();
    }
    const offset = (i % 16) * 2;
    out += String.fromCodePoint(
      0x20000 + (((digest[offset]! << 8) | digest[offset + 1]!) % 0xd000),
    );
  }
  return out;
}

/**
 * 圧縮が効かない長い hex（種から決まる）。⚠ `"ab".repeat(1600)` のような繰り返しは、
 * Postgres が索引の値を圧縮するので 2704 バイトの壁に届かず、直す前でも通ってしまう（実測）。
 */
function incompressibleHex(seed: string, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  }
  return out.slice(0, length);
}

function llmReturningClaim(claim: { subject: string; predicate: string }): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        return req.schema.parse({
          memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }],
        });
      }
      return req.schema.parse({ claims: [claim] });
    },
  };
}

async function observeWith(claim: { subject: string; predicate: string }, callCtx: Ctx) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const runtime = createRuntime({
    memoryStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: llmReturningClaim(claim),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
  });
  const result = await runtime.observe(callCtx, {
    kind: "utterance",
    text: "好きな食べ物はラーメン",
    claimKey: { enabled: true },
  });
  const memory = await memoryStore.get(callCtx, result.memoryIds[0]!);
  return { result, memory };
}

afterAll(async () => {
  await closeTestClient();
});

describe("claim key: 長さの上限（ADR 0433 決定1。@mnemora/postgres）", () => {
  it("3200 字の hex の predicate と subject でも observe は成功し、memory は作られ、鍵は null", async () => {
    await resetTestDatabase();
    const { result, memory } = await observeWith(
      { subject: incompressibleHex("s", 3200), predicate: incompressibleHex("p", 3200) },
      ctx,
    );
    expect(result.memoryIds).toHaveLength(1);
    expect(memory).not.toBeNull();
    expect(memory?.claimKey ?? null).toBeNull();
  });

  it("上限ちょうど（256 コードポイントの 4 バイト文字を subject と predicate の両方に）は、長い tenant_id・subject_id と一緒でも INSERT でき、鍵が残る", async () => {
    await resetTestDatabase();
    const longCtx: Ctx = { tenantId: "t".repeat(300), subjectId: "s".repeat(300) };
    const subject = astralNoise("subject", 256);
    const predicate = astralNoise("predicate", 256);
    expect(Buffer.byteLength(subject + predicate)).toBe(2048);
    const { memory } = await observeWith({ subject, predicate }, longCtx);
    expect(memory?.claimKey).toEqual({ subject, predicate });
  });
});
