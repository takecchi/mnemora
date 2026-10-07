import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * adapter の構築時に、SDK が組むのと同じヘッダの値を `Headers` に通して確かめ、通らなければキーを含まない例外を投げる。`Headers` が受け付ける値（末尾の空白・改行、途中の TAB など）は狭めない。
 * ここで使うキーは実在しない、この歯のためだけの文字列である。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const BROKEN_KEY = "sk-zq9X7vK2pL\nW8mR4tY6";

function keyFragments(key: string): string[] {
  const fragments: string[] = [];
  const parts = [...key]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? "\n" : ch))
    .join("")
    .split("\n");
  for (const part of parts) {
    for (let i = 0; i + 4 <= part.length; i++) {
      fragments.push(part.slice(i, i + 4));
    }
  }
  return fragments;
}

function expectNoKeyFragment(text: string | null | undefined, key: string): void {
  for (const fragment of keyFragments(key)) {
    expect(text ?? "", `キーの断片 ${JSON.stringify(fragment)} が載っている`).not.toContain(
      fragment,
    );
  }
}

function headerAccepts(key: string): boolean {
  try {
    new Headers().append("authorization", `Bearer ${key}`);
    return true;
  } catch {
    return false;
  }
}

// 万一ヘッダの検査を抜けても、外へは出ない先にしておく（送信の前に失敗するので、実際にはどこにも接続しない)。
const ORIGINAL_BASE_URL = process.env.OPENAI_BASE_URL;
beforeAll(() => {
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
});
afterAll(() => {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env.OPENAI_BASE_URL;
  } else {
    process.env.OPENAI_BASE_URL = ORIGINAL_BASE_URL;
  }
});

describe("@mnemora/openai: ヘッダに載せられない API キーは、キーを含まない例外で構築時に拒む（Issue #1080）", () => {
  function buildRuntimeOrConstructionError() {
    try {
      const llmProvider = new OpenAILLMProvider({ apiKey: BROKEN_KEY, model: "gpt-test" });
      const embeddingProvider = new OpenAIEmbeddingProvider({
        apiKey: BROKEN_KEY,
        model: "text-embedding-test",
        dimensions: 3,
      });
      const memoryStore = new InMemoryMemoryStore();
      const runtime = createRuntime({
        memoryStore,
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        vectorStore: new InMemoryVectorStore(memoryStore),
        eventStore: new InMemoryEventStore(memoryStore),
        tenantSettingsStore: new InMemoryTenantSettingsStore(),
        llmProvider,
        embeddingProvider,
        hashContent: (content) => createHash("sha256").update(content).digest("hex"),
      });
      return { runtime, memoryStore, constructionError: null };
    } catch (error) {
      return { runtime: null, memoryStore: null, constructionError: error };
    }
  }

  it("キーの途中に LF があっても、observe の extractionFailure.message にキーが残らない", async () => {
    const { runtime } = buildRuntimeOrConstructionError();
    if (runtime !== null) {
      const observed = await runtime.observe(ctx, { kind: "utterance", text: "こんにちは" });
      expectNoKeyFragment(observed.extractionFailure?.message, BROKEN_KEY);
    }
  });

  it("キーの途中に LF があっても、embed ジョブの失敗を記録した outbox の lastError にキーが残らない", async () => {
    const { runtime, memoryStore } = buildRuntimeOrConstructionError();
    if (runtime !== null && memoryStore !== null) {
      await runtime.observe(ctx, { kind: "utterance", text: "こんにちは" });
      await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
      expect(memoryStore.outboxJobs.some((job) => job.lastError != null)).toBe(true);
      for (const job of memoryStore.outboxJobs) {
        expectNoKeyFragment(job.lastError, BROKEN_KEY);
      }
    }
  });

  it("キーの途中に LF があると、構築時にキーを含まない例外を投げる（cause も持たない）", () => {
    const { constructionError } = buildRuntimeOrConstructionError();
    expect(constructionError).toBeInstanceOf(Error);
    expectNoKeyFragment((constructionError as Error).message, BROKEN_KEY);
    expectNoKeyFragment(String((constructionError as Error).stack), BROKEN_KEY);
    expect((constructionError as Error).cause).toBeUndefined();
  });

  const SAMPLES: [label: string, key: string][] = [
    ["途中に LF", "sk-zq9X7vK2pL\nW8mR4tY6"],
    ["途中に CR", "sk-zq9X7vK2pL\rW8mR4tY6"],
    ["途中に NUL", "sk-zq9X7vK2pL\u0000W8mR4tY6"],
    ["末尾に NUL", "sk-zq9X7vK2pLW8mR4tY6\u0000"],
    ["先頭に LF（Bearer の後ろに来るので途中になる）", "\nsk-zq9X7vK2pLW8mR4tY6"],
    ["U+0100 以上の文字", "sk-zq9X7vK2pLĀW8mR4tY6"],
    ["末尾に LF", "sk-zq9X7vK2pLW8mR4tY6\n"],
    ["末尾に CRLF", "sk-zq9X7vK2pLW8mR4tY6\r\n"],
    ["末尾に空白", "sk-zq9X7vK2pLW8mR4tY6 "],
    ["途中に TAB", "sk-zq9X7vK2pL\tW8mR4tY6"],
    ["途中に U+0001", "sk-zq9X7vK2pL\u0001W8mR4tY6"],
    ["Latin-1 の文字", "sk-zq9X7vK2pLéW8mR4tY6"],
    ["ふつうのキー", "sk-zq9X7vK2pLW8mR4tY6"],
  ];

  for (const [label, key] of SAMPLES) {
    const rejected = !headerAccepts(key);
    it(`${label}: Headers が${rejected ? "拒む" : "受け付ける"}とおりに、構築時に${rejected ? "キーを含まない例外を投げる" : "例外を投げない（狭めない）"}`, () => {
      for (const build of [
        () => new OpenAILLMProvider({ apiKey: key, model: "gpt-test" }),
        () => new OpenAIEmbeddingProvider({ apiKey: key, model: "m", dimensions: 3 }),
      ]) {
        if (rejected) {
          let error: unknown = null;
          try {
            build();
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/apiKey/);
          expectNoKeyFragment((error as Error).message, key);
          expect((error as Error).cause).toBeUndefined();
        } else {
          expect(build).not.toThrow();
        }
      }
    });
  }

  it("client を注入したときは検査しない（キーは注入した側のクライアントが持つ）", () => {
    const client = { chat: { completions: { create: async () => ({ choices: [] }) } } };
    expect(
      () =>
        new OpenAILLMProvider({ apiKey: BROKEN_KEY, model: "gpt-test", client: client as never }),
    ).not.toThrow();
  });
});
