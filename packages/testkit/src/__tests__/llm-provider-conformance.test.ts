// Issue #389 / ADR 0266: `LLMProvider` の適合テストを、testkit 自身が持つ実装
// （`DeterministicLLMProvider`）に当てる。
//
// ⛔ `RecordedLLMProvider`（ADR 0051）には当てない——カセットの fixture を要り射程が膨らむ。
// ADR 0266「引き受けた負債」に名指しした。
//
// ⭐ ここが持つ、もう一つの役目: `createFailing: null` を渡したとき、失敗系の歯
// （5〜8）が消えずに `it.skip` として名前が残ることを、この呼び出しを通して実際に確認する
// （vitest の出力に `↓` で名前が出る）。`DeterministicLLMProvider` は client を注入する口を
// 持たないため、`createFailing` を作りようが無い——これは手抜きではなく、実装の形からの帰結。

import { z } from "zod";
import { describeLLMProviderConformance } from "../llm-provider-conformance.js";
import { DeterministicLLMProvider } from "../__fixtures__/deterministic-llm-provider.js";

// `DeterministicLLMProvider.completeStructured` は3つの形（extraction / consolidation /
// reflection、`__fixtures__/deterministic-llm-provider.ts` の doc コメント）だけを知っている。
// ここでは consolidation の形（`{ content, digest?, tags? }`）に合わせる——
// `req.prompt.messages` の最後の user 発話を `content` として、40字までの `digest` を添えて
// 返す。同じ入力には同じ `userText` が渡るため、決定的である。
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
  // `DeterministicLLMProvider` は下層の client を注入する口を持たない（SDK を呼ばない
  // 純粋関数の stub）ため、下層の失敗を仕込みようが無い。`null` を明示する
  // （`LLMProviderConformanceOptions.createFailing` の doc コメントの通り）。
  createFailing: null,
});
