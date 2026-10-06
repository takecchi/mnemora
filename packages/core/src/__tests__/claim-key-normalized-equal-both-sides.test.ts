import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 穴 O-3（ADR 0424）の確かめ直し（Issue #1734、PR #1527）で足した歯。
 * 比べる規則は「NFC の後に `trim()`」だけで、**両側**を同じ規則で正規化して比べる。
 *
 * - 先に保存した側が NFD・末尾空白のとき（`claim-key-normalized-equal-not-contested.test.ts` は、
 *   後から来る側だけが崩れている）。
 * - 大文字小文字・全角半角・文中の空白の数は、規則の外（同じ文として扱わない）。矛盾として検出される。
 * - 既に `contested` の相手と content が等しい行も、件数から除く。
 */

const ctx: Ctx = { tenantId: "tenant-o3-both-sides" };

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

async function observeAll(contents: string[]) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: sameKeyLlm(contents),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  const opts = { claimKey: { enabled: true, detectContested: true } } as const;
  const results = [];
  for (const [i] of contents.entries()) {
    results.push(await runtime.observe(ctx, { kind: "utterance", text: `t${i}`, ...opts }));
  }
  return results;
}

describe("claim key の検出: 正規化は NFC + trim だけで、両側に同じ規則（ADR 0424）", () => {
  it("先に保存した側が NFD・末尾空白でも、同じ文は contested にならない", async () => {
    const nfc = "私が東京に住んでいる";
    const [, b] = await observeAll([`${nfc.normalize("NFD")} `, nfc]);
    expect(b!.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
  });

  it.each([
    ["大文字小文字だけが違う", "Address is Tokyo", "address is tokyo"],
    ["全角と半角だけが違う", "Tokyo 1", "Ｔｏｋｙｏ １"],
    ["文中の空白の数だけが違う", "address  is tokyo", "address is tokyo"],
  ])("%s文は、同じ文として扱わず contested になる", async (_label, first, second) => {
    const [, b] = await observeAll([first, second]);
    expect(b!.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested" }),
      }),
    ]);
  });

  it("既に contested の相手と content が等しい行は、件数に数えない", async () => {
    // A と B が contested になった後で、A と正規化すると等しい C が来る。数えるのは B だけ。
    const [, , c] = await observeAll(["住所は東京", "住所は大阪", "住所は東京 "]);
    expect(c!.contestedDetection).toEqual([expect.objectContaining({ matchCount: 1 })]);
  });
});
