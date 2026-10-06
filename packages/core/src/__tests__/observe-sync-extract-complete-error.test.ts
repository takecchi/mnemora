import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1492（ADR 0407）の変異試験で、
 * 「`observe({ extract: "sync" })` が `complete` の例外を全部握る」変異がすり抜けた。担当はクローン（miku）の
 * 判断で進めている作業であり、オーナーの判断ではない。
 *
 * ADR 0407 決定3: LLM がリースより長くかかり tick に取り直されたら、observe は `OutboxLeaseConflictError`
 * **だけ**を握って通常の結果（`memoryIds`）を返す。それ以外の例外（接続断・`TypeError` など）は今までどおり
 * 投げ直す。既存の歯（`observe-sync-extract-job-lease.test.ts`）は、リース競合の例外が握られることしか
 * 見ていなかった。
 */

const ctx: Ctx = { tenantId: "observe-sync-extract-complete-error" };

const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({ memories: [{ content: "候補", provenanceKind: "stated" }] }),
};

function makeKit(completeThrows: () => Error) {
  const stores = createFakeRuntimeStores();
  const outboxStore = new Proxy(stores.outboxStore, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "complete") {
        return async () => {
          throw completeThrows();
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createRuntime({
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
    memoryStore: stores.memoryStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    outboxStore,
    tenantSettingsStore: stores.tenantSettingsStore,
  });
}

describe("sync observe: extract ジョブの complete の失敗の扱い（ADR 0407 決定3、Issue #1734）", () => {
  it("陽性対照: complete が OutboxLeaseConflictError で落ちても、observe は握って memoryIds を返す", async () => {
    const runtime = makeKit(() => new OutboxLeaseConflictError("job-1", 1, 2));
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.memoryIds).toHaveLength(1);
  });

  it.each([
    ["接続断（素の Error）", () => new Error("connection lost")],
    ["TypeError", () => new TypeError("boom")],
  ])("complete がリース競合以外（%s）で落ちたら、握らずに投げ直す", async (_label, make) => {
    const error = make();
    const runtime = makeKit(() => error);
    await expect(runtime.observe(ctx, { kind: "utterance", text: "発話" })).rejects.toBe(error);
  });
});
