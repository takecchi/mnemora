import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import * as providerModule from "../llm-provider.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/** doc の値は `llm-provider.ts` の TSDoc を読んで取り、実装の値は `maxTokens` を省いた provider が実際に送るリクエストから取る。 */

const SOURCE = readFileSync(fileURLToPath(new URL("../llm-provider.ts", import.meta.url)), "utf8");

function linkedConstantOfMaxTokens(): string {
  const at = SOURCE.indexOf("\n  maxTokens?:");
  const doc = SOURCE.slice(SOURCE.lastIndexOf("/**", at), at);
  const m = doc.match(/省略時\s*\{@link\s+([A-Z0-9_]+)\}/);
  if (!m) throw new Error("maxTokens の TSDoc に既定の記述が見つからない");
  return m[1]!;
}

function numberInConstantDoc(name: string): number {
  const at = SOURCE.indexOf(`export const ${name} =`);
  const doc = SOURCE.slice(SOURCE.lastIndexOf("/**", at), at);
  const m = doc.match(/([0-9][0-9_,]*) という値/);
  if (!m) throw new Error(`${name} の doc に値の記述が見つからない`);
  return Number(m[1]!.replace(/[_,]/g, ""));
}

const ctx: Ctx = { tenantId: "max-tokens-default-doc" };

describe("AnthropicLLMProvider の maxTokens の既定は TSDoc の値と一致する", () => {
  it("maxTokens を省くと、doc が指す定数（とその doc の数字）の値を max_tokens として送る", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const provider = new AnthropicLLMProvider({
      apiKey: "unused",
      model: "claude-test",
      client: { messages: { create } } as never,
    });
    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    const name = linkedConstantOfMaxTokens();
    const linked = (providerModule as Record<string, unknown>)[name];
    const sent = (create.mock.calls[0] as unknown as [{ max_tokens: number }])[0].max_tokens;
    expect(sent).toBe(linked);
    expect(sent).toBe(numberInConstantDoc(name));
  });
});
