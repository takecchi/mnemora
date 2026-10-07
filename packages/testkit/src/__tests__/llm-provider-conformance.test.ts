// `createFailing: null` を渡したとき、失敗系の歯が消えずに `it.skip` として名前が残ることを、この呼び出しで確かめる。`DeterministicLLMProvider` は client を注入する口を持たないので、`createFailing` を作れない。

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PromptSpec } from "@mnemora/core";
import { describeLLMProviderConformance } from "../llm-provider-conformance.js";
import { DeterministicLLMProvider } from "../__fixtures__/deterministic-llm-provider.js";
import { llmCassetteKey, type LLMCassetteSection } from "../__fixtures__/cassette.js";
import { RecordedLLMProvider } from "../__fixtures__/recorded-llm-provider.js";

const structuredSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

describeLLMProviderConformance({
  name: "DeterministicLLMProvider",
  createProvider: () => new DeterministicLLMProvider(),
  deterministic: true,
  prompt: { messages: [{ role: "user", content: "決定的な入力" }] },
  structured: {
    prompt: { messages: [{ role: "user", content: "決定的な構造化入力" }] },
    schema: structuredSchema,
  },
  createFailing: null,
});

const RECORDED_PROMPT: PromptSpec = {
  messages: [{ role: "user", content: "recorded: 決定的な入力" }],
};

const RECORDED_STRUCTURED_PROMPT: PromptSpec = {
  messages: [{ role: "user", content: "recorded: 決定的な構造化入力" }],
};

const recordedStructuredSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
});

/** 記録値に、schema に無い余計な欄をわざと載せる。余計な欄が消えるのは `RecordedLLMProvider` 固有のロジックではなく、zod の `z.object(...)` が未知の欄を strip するため（`safeParse` を経由しない実装に変えるとこの歯は赤くなる）。 */
const recordedStructuredValueWithVendorField = {
  content: "recorded structured content",
  digest: "digest-value",
  vendorNote: "vendor-only field that recordedStructuredSchema does not declare",
};

const recordedSection: LLMCassetteSection = {
  model: "gpt-4o-mini",
  entries: {
    [llmCassetteKey(RECORDED_PROMPT)]: {
      prompt: RECORDED_PROMPT,
      value: { content: "recorded content" },
    },
    [llmCassetteKey(RECORDED_STRUCTURED_PROMPT)]: {
      prompt: RECORDED_STRUCTURED_PROMPT,
      value: recordedStructuredValueWithVendorField,
    },
  },
};

describe("適合テストの前提（RecordedLLMProvider）: complete 用の記録値はちょうど { content } の形で、completeStructured 用の記録値は schema に無い欄を実際に持つ（無いと適合テストが何も確かめないまま緑になる）", () => {
  it("complete 用の記録値は、ちょうど { content } の形をしている（歯1が検査する形そのもの）", () => {
    const entry = recordedSection.entries[llmCassetteKey(RECORDED_PROMPT)];
    expect(Object.keys(entry?.value as object)).toEqual(["content"]);
  });

  it("completeStructured 用の記録値は、schema に無い欄を実際に持つ", () => {
    const declared = new Set(Object.keys(recordedStructuredSchema.shape));
    expect(declared.has("vendorNote")).toBe(false);
    expect("vendorNote" in recordedStructuredValueWithVendorField).toBe(true);
  });
});

describeLLMProviderConformance({
  name: "RecordedLLMProvider",
  createProvider: () => new RecordedLLMProvider({ section: recordedSection }),
  // 決定性を与えているのは記録値の再生であって、記録元の実 API が決定的であることの証明ではない。
  deterministic: true,
  prompt: RECORDED_PROMPT,
  structured: {
    prompt: RECORDED_STRUCTURED_PROMPT,
    schema: recordedStructuredSchema,
  },
  createFailing: null,
});
