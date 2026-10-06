import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `Runtime.observe` の TSDoc（Issue #897）を縛る。振る舞いは変えていない。
 *
 * `forget()` で `forgotten` になった、あるいはさらに `purge()` した Memory の元になった Observation と
 * 同じ `externalId` で `observe()` を呼び直しても、抽出はやり直さず
 * `{ memoryIds: [], extraction: 'skipped', extractionFailure: null }` を返す。`extract: 'sync'`/`'deferred'` の
 * どちらでも同じ。ここでは、再送の間に LLM が1回も呼ばれないこと、deferred の再送が extract ジョブを積まないこと
 * （後の `tick` が何も処理しない）、消した記憶が戻らないことまで見る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const LEASE_MS = 60_000;

function countingLlm(): LLMProvider & { structuredCalls: number } {
  const provider = {
    structuredCalls: 0,
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      provider.structuredCalls += 1;
      return req.schema.parse({
        memories: [{ content: "東京に住んでいる", provenanceKind: "stated" }],
      }) as T;
    },
  };
  return provider;
}

function build() {
  const stores = createFakeRuntimeStores();
  const llm = countingLlm();
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
  return { runtime, stores, llm };
}

const MODES = ["sync", "deferred"] as const;
const WITHDRAWALS = ["forget", "forget + purge"] as const;

describe("runtime.observe: forget・purge した記憶の Observation と同じ externalId で再送すると skipped（#897）", () => {
  for (const mode of MODES) {
    for (const withdrawal of WITHDRAWALS) {
      it(`extract: ${mode}、${withdrawal} の後の再送は LLM を呼ばず、抽出をやり直さない`, async () => {
        const { runtime, stores, llm } = build();
        const input = {
          kind: "utterance" as const,
          text: "東京に住んでいます",
          externalId: `ext-${mode}-${withdrawal}`,
          extract: mode,
        };

        const first = await runtime.observe(ctx, input);
        if (mode === "deferred") {
          await runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
        }
        const memories = await stores.memoryStore.listBySourceObservation(
          ctx,
          first.observationId,
          "v1",
        );
        // 前提: 最初の observe で記憶が1件でき、LLM はそのために1回呼ばれた。
        expect(memories).toHaveLength(1);
        expect(llm.structuredCalls).toBe(1);
        const memoryId = memories[0]!.id;

        await runtime.forget(ctx, { memoryId });
        if (withdrawal === "forget + purge") {
          await runtime.purge(ctx, { memoryId });
        }
        const callsBefore = llm.structuredCalls;

        const resent = await runtime.observe(ctx, input);
        const afterTick = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });

        expect({
          resent,
          llmCallsDuringResend: llm.structuredCalls - callsBefore,
          processedByLaterTick: afterTick.processed,
          memoriesOfObservation: (
            await stores.memoryStore.listBySourceObservation(ctx, first.observationId, "v1")
          ).map((m) => ({ id: m.id, status: m.status })),
        }).toEqual({
          resent: {
            observationId: first.observationId,
            memoryIds: [],
            extraction: "skipped",
            extractionFailure: null,
            // ADR 0639: 再送の内訳。forget の後は forgotten・purged: false、purge の後は purged: true。
            resend: {
              memories: [
                { memoryId, status: "forgotten", purged: withdrawal === "forget + purge" },
              ],
            },
          },
          llmCallsDuringResend: 0,
          processedByLaterTick: 0,
          memoriesOfObservation: [{ id: memoryId, status: "forgotten" }],
        });
      });
    }
  }
});
