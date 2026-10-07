import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * doc の値は `docs/memory-model.md` を実行時に読み（§5 の追記と、状態遷移の表の注記の2か所。両者が食い違えばそれだけで赤）、
 * 実装の値は `detectContested` を省いた `observe()` が `findActiveByClaimKey` を呼ぶかどうかから取って突き合わせる。
 * 渡したときに検出が実際に走ることも同じ `it` で見る: 省いたときに呼ばれないのが既定だからであって、
 * 配線が切れているからではないことを確かめるため。
 */

const MEMORY_MODEL_DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/memory-model.md", import.meta.url)),
  "utf8",
);

function docMatch(pattern: RegExp): RegExpMatchArray {
  const m = MEMORY_MODEL_DOC.match(pattern);
  if (!m) throw new Error(`docs/memory-model.md に ${pattern} の記述が見つからない`);
  return m;
}

function sequencedLlm(responses: unknown[]): LLMProvider {
  let index = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if (index >= responses.length) throw new Error(`応答が足りない（${index + 1} 回目）`);
      return req.schema.parse(responses[index++]) as T;
    },
  };
}

const ctx: Ctx = { tenantId: "memory-model-doc-detect-contested-default" };

/** claim key を付けて1回 observe し、`findActiveByClaimKey` が呼ばれた回数を返す。 */
async function findCalls(claimKey: { enabled: true; detectContested?: boolean }) {
  const stores = createFakeRuntimeStores();
  let calls = 0;
  const original = stores.memoryStore.findActiveByClaimKey.bind(stores.memoryStore);
  stores.memoryStore.findActiveByClaimKey = (async (...args: Parameters<typeof original>) => {
    calls += 1;
    return original(...args);
  }) as typeof stores.memoryStore.findActiveByClaimKey;
  const runtime = createRuntime({
    ...stores,
    llmProvider: sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]),
    hashContent: (content: string) => `h:${content}`,
  });
  const result = await runtime.observe(ctx, {
    kind: "utterance",
    text: "好きな食べ物はラーメン",
    claimKey,
  });
  return { calls, hasDetection: "contestedDetection" in result };
}

describe("docs/memory-model.md の detectContested の既定は、observe() の振る舞いと一致する", () => {
  it("§5 の追記と状態遷移の表の注記が書く既定（on / off）", async () => {
    const inSection = docMatch(
      /\*\*既定は (on|off) のまま\*\*（`detectContested` を渡さない・`enabled: false` の呼び出しは、\s*`findActiveByClaimKey` を一度も呼ばない）/,
    )[1];
    const inTransitionNote = docMatch(
      /`claimKey: \{ enabled:\s*true, detectContested: true \}`、既定 (on|off)。/,
    )[1];
    expect(inTransitionNote).toBe(inSection);

    const omitted = await findCalls({ enabled: true });
    const explicit = await findCalls({ enabled: true, detectContested: true });
    expect(explicit.calls).toBeGreaterThan(0);
    expect(explicit.hasDetection).toBe(true);

    const defaultIsOn = omitted.calls > 0;
    expect(defaultIsOn ? "on" : "off").toBe(inSection);
    expect(omitted.hasDetection).toBe(defaultIsOn);
  });
});
