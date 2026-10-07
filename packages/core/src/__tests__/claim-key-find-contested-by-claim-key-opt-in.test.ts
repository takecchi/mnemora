import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-933-opt-in" };

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
      return req.schema.parse({ claims: [{ subject: "user", predicate: "favorite_food" }] });
    },
  };
}

/**
 * `obj[key]` を呼び出し回数を数える wrapper に差し替える。`obj[key]` が `undefined`
 * （store がその任意メソッドを実装していない）なら、常に0を返す no-op スパイにする
 * ——「実装していない store では呼ばれようがない」ことをこの関数自身が表す。
 */
function countingSpy<T extends Record<string, unknown>>(
  obj: T,
  key: keyof T & string,
): { calls: () => number } {
  const original = obj[key] as unknown as ((...args: unknown[]) => unknown) | undefined;
  if (original === undefined) {
    return { calls: () => 0 };
  }
  let count = 0;
  (obj as Record<string, unknown>)[key] = (...args: unknown[]) => {
    count += 1;
    return original.apply(obj, args);
  };
  return { calls: () => count };
}

function buildRuntimeWithStores(contents: string[]) {
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
  return { runtime, stores };
}

describe("findContestedByClaimKey: 既定 off では一度も呼ばれない", () => {
  it("claimKey を渡さない observe では、findActiveByClaimKey・findContestedByClaimKey とも0回", async () => {
    const { runtime, stores } = buildRuntimeWithStores(["好きな食べ物はラーメン"]);
    const activeSpy = countingSpy(
      stores.memoryStore as unknown as Record<string, unknown>,
      "findActiveByClaimKey",
    );
    const contestedSpy = countingSpy(
      stores.memoryStore as unknown as Record<string, unknown>,
      "findContestedByClaimKey",
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
    });
    expect("contestedDetection" in result).toBe(false);
    expect(activeSpy.calls()).toBe(0);
    expect(contestedSpy.calls()).toBe(0);
  });

  it("claimKey: { enabled: true, detectContested: false } では、findContestedByClaimKey は0回", async () => {
    const { runtime, stores } = buildRuntimeWithStores(["好きな食べ物はラーメン"]);
    const contestedSpy = countingSpy(
      stores.memoryStore as unknown as Record<string, unknown>,
      "findContestedByClaimKey",
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: false },
    });
    expect("contestedDetection" in result).toBe(false);
    expect(contestedSpy.calls()).toBe(0);
  });
});

describe("findContestedByClaimKey: opt-in を on にした経路は、実装の有無で決まった結果になる", () => {
  it("実装している store（core の Fake）: 3件目は active(0)+contested(2) を合わせて matchCount 2、unresolved_conflict で固定される", async () => {
    const { runtime, stores } = buildRuntimeWithStores([
      "好きな食べ物はラーメン",
      "好きな食べ物は寿司",
      "好きな食べ物はカレー",
    ]);
    expect(stores.memoryStore.findContestedByClaimKey).toBeDefined();
    const contestedSpy = countingSpy(
      stores.memoryStore as unknown as Record<string, unknown>,
      "findContestedByClaimKey",
    );

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      claimKey: { enabled: true, detectContested: true },
    });
    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はカレー",
      claimKey: { enabled: true, detectContested: true },
    });

    expect(first.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    expect(second.contestedDetection?.[0]?.matchCount).toBe(1);
    expect(second.contestedDetection?.[0]?.result.kind).toBe("contested");
    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);
    expect(contestedSpy.calls()).toBe(3);

    const thirdMemory = await stores.memoryStore.get(ctx, third.memoryIds[0]!);
    expect(thirdMemory?.status).toBe("active");
    expect(thirdMemory?.contestedWithId ?? null).toBeNull();
  });

  it("実装していない store（後方互換）: findContestedByClaimKey が undefined のままなら、3件目は今までどおり no_conflict で固定される", async () => {
    const { runtime, stores } = buildRuntimeWithStores([
      "好きな食べ物はラーメン",
      "好きな食べ物は寿司",
      "好きな食べ物はカレー",
    ]);
    // @ts-expect-error テスト用に任意メソッドを取り除く。
    stores.memoryStore.findContestedByClaimKey = undefined;

    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      claimKey: { enabled: true, detectContested: true },
    });
    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はカレー",
      claimKey: { enabled: true, detectContested: true },
    });

    expect(third.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const thirdMemory = await stores.memoryStore.get(ctx, third.memoryIds[0]!);
    expect(thirdMemory?.status).toBe("active");
    expect(thirdMemory?.contestedWithId ?? null).toBeNull();
  });
});
