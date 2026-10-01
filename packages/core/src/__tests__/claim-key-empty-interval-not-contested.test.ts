import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 空の区間（`validFrom === validUntil`）・逆転した区間（`validFrom > validUntil`）の記憶は、`recall()` の
 * `validAt` ゲートをどの時点でも通らない——**真であった瞬間が無い**。そういう記憶が、同じ claim key の有効な記憶と
 * 「有効期間が重なる」として矛盾（`contested`）を作ってはならない（ADR 0324 決定4: 重なりは矛盾の必要条件）。
 *
 * 【実測 2026-10-01】直す前は、有効な1件目の後に、空・逆転した区間の2件目を `observe` すると、2件とも `contested`
 * になった。陽性対照: 普通の区間（1件目と重なる）の2件目は、直す前も後も `contested` になる。
 */

const ctx: Ctx = { tenantId: "claim-key-empty-interval-core" };

function sameKeyLlm(contents: string[]): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        return req.schema.parse({
          memories: [{ content: contents[next++]!, provenanceKind: "stated" }],
        });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "address" }] });
    },
  };
}

async function run(second: { validFrom: Date; validUntil: Date }) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: sameKeyLlm(["住所は東京", "住所は大阪"]),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  const first = await runtime.observe(ctx, {
    kind: "utterance",
    text: "住所は東京",
    claimKey: { enabled: true, detectContested: true },
  });
  const result = await runtime.observe(ctx, {
    kind: "utterance",
    text: "住所は大阪",
    claimKey: { enabled: true, detectContested: true },
    ...second,
  });
  const a = await stores.memoryStore.get(ctx, first.memoryIds[0]!);
  const b = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
  return { result, a, b };
}

describe("claim key の検出: 真であった瞬間が無い区間の記憶は矛盾を作らない（core の Fake）", () => {
  it("陽性対照: 普通の区間の2件目は、期間が重なる1件目（両端 null）と contested になる", async () => {
    const { result, a, b } = await run({
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2030-01-01T00:00:00Z"),
    });
    expect(result.contestedDetection?.[0]?.result.kind).toBe("contested");
    expect(a?.status).toBe("contested");
    expect(b?.status).toBe("contested");
  });

  it.each([
    ["空の区間", new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z")],
    ["逆転した区間", new Date("2029-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z")],
  ] as const)(
    "%sの2件目は、有効な1件目を contested にしない",
    async (_label, validFrom, validUntil) => {
      const { result, a, b } = await run({ validFrom, validUntil });
      expect(result.contestedDetection?.[0]).toEqual(
        expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
      );
      expect(a?.status).toBe("active");
      expect(b?.status).toBe("active");
    },
  );
});
