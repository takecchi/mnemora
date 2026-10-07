import { describe, expect, it } from "vitest";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

function build(config?: unknown) {
  const stores = createFakeRuntimeStores();
  return createRuntime({
    memoryStore: stores.memoryStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    outboxStore: stores.outboxStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    embeddingProvider: stores.embeddingProvider,
    llmProvider: { complete: async () => ({}) } as never,
    hashContent: (content: string) => `h(${content})`,
    ...(config === undefined ? {} : { config: config as never }),
  });
}

describe("createRuntime: config.extractorVersion", () => {
  it.each([
    ["空文字", ""],
    ["空白だけ", "  "],
    ["タブと改行だけ", "\t\n"],
  ])("%s なら、素の Error で拒む", (_label, extractorVersion) => {
    expect(() => build({ extractorVersion })).toThrow(
      new Error("createRuntime: config.extractorVersion must not be empty or whitespace-only"),
    );
  });

  it.each([
    ["config を省略", undefined],
    ["extractorVersion を省略", {}],
    ["extractorVersion が undefined", { extractorVersion: undefined }],
    ["extractorVersion が null（既定に倒す）", { extractorVersion: null }],
    ['"v1"', { extractorVersion: "v1" }],
    ['前後に空白のある " v1 "', { extractorVersion: " v1 " }],
  ])("%s なら、投げない", (_label, config) => {
    expect(() => build(config)).not.toThrow();
  });
});
