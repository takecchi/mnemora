import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import { DeterministicEmbeddingProvider } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * Issue #1080: `@mnemora/openai` の `api-key-header-safety.test.ts` と同じ判定を
 * `AnthropicLLMProvider` に当てる。SDK は `apiKey` を `x-api-key` ヘッダで、`authToken`
 * （`ANTHROPIC_AUTH_TOKEN` から読まれうる）を `Authorization: Bearer <authToken>` で送る。
 * 途中に CR・LF・NUL があると、`fetch` の例外文にキー全体が入り、`observe` の
 * `extractionFailure.message` に残っていた。
 *
 * ここで使うキーは実在しない、この歯のためだけの文字列である。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const BROKEN_KEY = "sk-ant-zq9X7vK2pL\nW8mR4tY6";

function keyFragments(key: string): string[] {
  const fragments: string[] = [];
  // 制御文字（U+0000〜U+001F・U+007F）で区切る。
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

function headerAccepts(name: string, value: string): boolean {
  try {
    new Headers().append(name, value);
    return true;
  } catch {
    return false;
  }
}

function constructionError(build: () => unknown): Error | null {
  try {
    build();
    return null;
  } catch (error) {
    return error as Error;
  }
}

// SDK は `authToken` を省略すると `ANTHROPIC_AUTH_TOKEN` を読む。この歯の外の環境に
// 左右されないよう、テストの間は外しておく。万一ヘッダの検査を抜けても外へ出ないよう、
// 接続先もローカルにしておく（送信の前に失敗するので、実際にはどこにも接続しない）。
const ORIGINAL_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
};
beforeAll(() => {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
});
afterAll(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("@mnemora/anthropic: ヘッダに載せられない API キーは、キーを含まない例外で構築時に拒む（Issue #1080）", () => {
  it("キーの途中に LF があっても、observe の extractionFailure.message にキーが残らない", async () => {
    let llmProvider: AnthropicLLMProvider | null = null;
    try {
      llmProvider = new AnthropicLLMProvider({ apiKey: BROKEN_KEY, model: "claude-test" });
    } catch {
      // 構築時に拒まれた——この歯の関心（キーが残らないこと）は満たされている。
    }
    if (llmProvider !== null) {
      const memoryStore = new InMemoryMemoryStore();
      const runtime = createRuntime({
        memoryStore,
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        vectorStore: new InMemoryVectorStore(memoryStore),
        eventStore: new InMemoryEventStore(memoryStore),
        tenantSettingsStore: new InMemoryTenantSettingsStore(),
        llmProvider,
        embeddingProvider: new DeterministicEmbeddingProvider(),
        hashContent: (content) => createHash("sha256").update(content).digest("hex"),
      });
      const observed = await runtime.observe(ctx, { kind: "utterance", text: "こんにちは" });
      expectNoKeyFragment(observed.extractionFailure?.message, BROKEN_KEY);
    }
  });

  it("キーの途中に LF があると、構築時にキーを含まない例外を投げる（cause も持たない）", () => {
    const error = constructionError(
      () => new AnthropicLLMProvider({ apiKey: BROKEN_KEY, model: "claude-test" }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/apiKey/);
    expectNoKeyFragment(error?.message, BROKEN_KEY);
    expectNoKeyFragment(String(error?.stack), BROKEN_KEY);
    expect(error?.cause).toBeUndefined();
  });

  const SAMPLES: [label: string, key: string][] = [
    ["途中に LF", "sk-ant-zq9X7vK2pL\nW8mR4tY6"],
    ["途中に CR", "sk-ant-zq9X7vK2pL\rW8mR4tY6"],
    ["途中に NUL", "sk-ant-zq9X7vK2pL\u0000W8mR4tY6"],
    ["末尾に NUL", "sk-ant-zq9X7vK2pLW8mR4tY6\u0000"],
    ["U+0100 以上の文字", "sk-ant-zq9X7vK2pLĀW8mR4tY6"],
    ["先頭に LF（x-api-key では前後の空白として切られる）", "\nsk-ant-zq9X7vK2pLW8mR4tY6"],
    ["末尾に LF", "sk-ant-zq9X7vK2pLW8mR4tY6\n"],
    ["末尾に CRLF", "sk-ant-zq9X7vK2pLW8mR4tY6\r\n"],
    ["末尾に空白", "sk-ant-zq9X7vK2pLW8mR4tY6 "],
    ["途中に TAB", "sk-ant-zq9X7vK2pL\tW8mR4tY6"],
    ["途中に U+0001", "sk-ant-zq9X7vK2pL\u0001W8mR4tY6"],
    ["Latin-1 の文字", "sk-ant-zq9X7vK2pLéW8mR4tY6"],
    ["ふつうのキー", "sk-ant-zq9X7vK2pLW8mR4tY6"],
  ];

  for (const [label, key] of SAMPLES) {
    const rejected = !headerAccepts("x-api-key", key);
    it(`${label}: Headers が${rejected ? "拒む" : "受け付ける"}とおりに、構築時に${rejected ? "キーを含まない例外を投げる" : "例外を投げない（狭めない）"}`, () => {
      const error = constructionError(
        () => new AnthropicLLMProvider({ apiKey: key, model: "claude-test" }),
      );
      if (rejected) {
        expect(error).toBeInstanceOf(Error);
        expectNoKeyFragment(error?.message, key);
        expect(error?.cause).toBeUndefined();
      } else {
        expect(error).toBeNull();
      }
    });
  }

  it("ANTHROPIC_AUTH_TOKEN の途中に LF があるときも、authToken を名指しし、値を含まない例外を投げる", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = BROKEN_KEY;
    try {
      const error = constructionError(
        () =>
          new AnthropicLLMProvider({ apiKey: "sk-ant-zq9X7vK2pLW8mR4tY6", model: "claude-test" }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/authToken/);
      expectNoKeyFragment(error?.message, BROKEN_KEY);
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it("client を注入したときは検査しない（キーは注入した側のクライアントが持つ）", () => {
    const client = { messages: { create: async () => ({ content: [] }) } };
    expect(
      () =>
        new AnthropicLLMProvider({
          apiKey: BROKEN_KEY,
          model: "claude-test",
          client: client as never,
        }),
    ).not.toThrow();
  });
});
