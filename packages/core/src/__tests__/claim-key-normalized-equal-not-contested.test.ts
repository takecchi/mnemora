import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 穴 O-3（ADR 0424）: contested の検出が、NFC と NFD の違いや末尾の空白だけで、
 * 同じ文を矛盾と判定していた。`findActiveByClaimKey?`/`findContestedByClaimKey?` は生の
 * `content_hash`（生の文字列の sha256）だけで「同じ内容」を除くため、見た目が同じ文が
 * 別の hash になり、一致に数えられていた。
 *
 * 直し: `Runtime.detectClaimKeyContested` が、store から返った行の `content` を
 * 比較用に正規化（NFC の後に trim）し、検出中の memory の content と等しい行を、件数を
 * 数える前に除く。保存値と `content_hash` は変えない。
 *
 * 同じ歯を `@mnemora/postgres` で縛るのは
 * `packages/postgres/src/__tests__/claim-key-normalized-equal.postgres.test.ts`。
 */

const ctx: Ctx = { tenantId: "tenant-o3" };

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

async function observeTwice(first: string, second: string) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: sameKeyLlm([first, second]),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  const opts = { claimKey: { enabled: true, detectContested: true } } as const;
  const a = await runtime.observe(ctx, { kind: "utterance", text: "first", ...opts });
  const b = await runtime.observe(ctx, { kind: "utterance", text: "second", ...opts });
  const memA = await stores.memoryStore.get(ctx, a.memoryIds[0]!);
  const memB = await stores.memoryStore.get(ctx, b.memoryIds[0]!);
  return { a, b, memA, memB };
}

describe("claim key の検出: 正規化すると同じ content は互いに contested にならない（穴 O-3、ADR 0424、core の Fake）", () => {
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
