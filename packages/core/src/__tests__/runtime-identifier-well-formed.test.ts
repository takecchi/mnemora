import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["孤立した上位サロゲート", "id-\uD800"],
  ["孤立した下位サロゲート", "id-\uDC00"],
  ["逆順に並んだサロゲート", "id-\uDC00\uD800"],
  ["NUL", "id-\u0000"],
];

async function rejection(promise: Promise<unknown>): Promise<{ kind?: unknown; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { kind?: unknown; message: string };
  }
  return { kind: "(reject しなかった)", message: "" };
}

describe("runtime の入口は、保存の形で区別できない識別子を断る", () => {
  for (const [label, value] of CASES) {
    it(`${label}: 公開の全メソッドが ctx.tenantId を断る`, async () => {
      const { runtime } = buildRuntime();
      for (const name of Object.keys(runtime) as Array<keyof typeof runtime>) {
        const call = runtime[name] as unknown as (ctx: Ctx, arg: unknown) => Promise<unknown>;
        const reason = await rejection(call({ tenantId: value }, {}));
        expect(reason.kind, `${name}: ${reason.message.slice(0, 100)}`).toBe(
          "malformed_identifier",
        );
        expect(reason.message).not.toContain(value);
      }
    });

    it(`${label}: 公開の全メソッドが ctx.subjectId を断る`, async () => {
      const { runtime } = buildRuntime();
      for (const name of Object.keys(runtime) as Array<keyof typeof runtime>) {
        const call = runtime[name] as unknown as (ctx: Ctx, arg: unknown) => Promise<unknown>;
        const reason = await rejection(call({ tenantId: "t", subjectId: value }, {}));
        expect(reason.kind, `${name}: ${reason.message.slice(0, 100)}`).toBe(
          "malformed_identifier",
        );
      }
    });

    it(`${label}: observe は入力の subjectId と externalId を断り、何も書かない`, async () => {
      const { runtime, stores } = buildRuntime();
      const ctx: Ctx = { tenantId: "t" };
      for (const extra of [{ subjectId: value }, { externalId: value }]) {
        const reason = await rejection(
          runtime.observe(ctx, { kind: "utterance", text: "本文", ...extra }),
        );
        expect(reason.kind).toBe("malformed_identifier");
        expect(reason.message).not.toContain(value);
      }
      const usage = await rejection(
        runtime.observe(ctx, {
          kind: "memory_usage",
          recallId: "r",
          memoryIds: [],
          externalId: value,
        } as never),
      );
      expect(usage.kind).toBe("malformed_identifier");
      expect(await stores.eventStore.list(ctx, {})).toEqual([]);
    });
  }

  it("本文（text）の孤立サロゲートは断らない（本文は識別子ではない）", async () => {
    const { runtime } = buildRuntime();
    const result = await runtime.observe(
      { tenantId: "t" },
      { kind: "utterance", text: "本文\uD800" },
    );
    expect(result.observationId).toBeTruthy();
  });

  it("対をなすサロゲート（絵文字）を含む識別子は受け付ける", async () => {
    const { runtime } = buildRuntime();
    const result = await runtime.observe(
      { tenantId: "t-\u{1F600}", subjectId: "u-\u{1F600}" },
      { kind: "utterance", text: "本文", externalId: "e-\u{1F600}" },
    );
    expect(result.observationId).toBeTruthy();
  });
});
