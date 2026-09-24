// Issue #389 / ADR 0266: `LLMProvider` の適合テストを、testkit 自身が持つ実装
// （`DeterministicLLMProvider`・`RecordedLLMProvider`）に当てる。
//
// ⭐ ここが持つ、もう一つの役目: `createFailing: null` を渡したとき、失敗系の歯
// （5〜8）が消えずに `it.skip` として名前が残ることを、この呼び出しを通して実際に確認する
// （vitest の出力に `↓` で名前が出る）。`DeterministicLLMProvider` は client を注入する口を
// 持たないため、`createFailing` を作りようが無い——これは手抜きではなく、実装の形からの帰結。

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PromptSpec } from "@mnemora/core";
import { describeLLMProviderConformance } from "../llm-provider-conformance.js";
import { DeterministicLLMProvider } from "../__fixtures__/deterministic-llm-provider.js";
import { llmCassetteKey, type LLMCassetteSection } from "../__fixtures__/cassette.js";
import { RecordedLLMProvider } from "../__fixtures__/recorded-llm-provider.js";

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

// ---------------------------------------------------------------------------
// Issue #389 / ADR 0266 追記（2026-09-24）: `RecordedLLMProvider`（ADR 0051）に当てる。
//
// ADR 0266 決定5は「RecordedLLMProvider には当てない」を**却下ではなく負債1**として
// 持ち越し、「これが覆るとしたら」節で自ら次の一手を名指ししている（逐語）:
//
//   `RecordedLLMProvider` 用のカセット fixture を用意したとき。負債1 を返す一手が
//   そのまま次に取れる（この呼び出しを1本足すだけで済む形にしてある）。
//
// 本ブロックはその条件を満たす。カセットは実 API を録ったものではなく、この suite の
// ためだけに手で組み立てたインメモリの `LLMCassetteSection`（鍵は本物と同じ
// `llmCassetteKey` の導出を使う）。
// ---------------------------------------------------------------------------

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

/**
 * 🔴 **記録値に、schema に無い余計な欄をわざと載せる。これは意図であって手抜きではない**
 * （anthropic/openai 側の `structuredPayloadWithVendorField` と同じ発想）。
 *
 * ⚠ **ただし意義の強さが違う。**anthropic/openai では `completeStructured` が
 * `schema.parse(...)` を**自前で呼んでいる**実装コードであり、この歯はその呼び出しが
 * 消えていないかを検査する。`RecordedLLMProvider.completeStructured` も
 * `req.schema.safeParse(entry.value)` を呼んではいるが、**余計な欄が消える理由は
 * `RecordedLLMProvider` 固有のロジックではなく、zod の `z.object(...)` が既定で持つ
 * 「未知の欄は strip する」という振る舞いである。** ⟹ この歯が緑になることは
 * 「RecordedLLMProvider が漏れを防ぐコードを書いている」ことの証明ではなく、
 * 「zod の strip に乗っている」ことの反映にすぎない——下の変異試験 M2 が、
 * `safeParse` を経由しない実装に変えると実際に歯2 が赤くなることで、この依存を裏付ける。
 */
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

/**
 * 🔴 適合テストの前に、**足場が歯を空回りさせていない**ことを測る
 * （anthropic/openai 側の「適合テストの前提」と同じ発想）。
 */
describe("適合テストの前提（RecordedLLMProvider）: 足場が歯を空回りさせていない", () => {
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
  // カセット再生は、同じプロンプトに対して常に同じ記録値を返す（`lookup` は同じ鍵に対して
  // 同じ entry を返すだけの純粋な参照）。⚠ **決定性を与えているのは記録値の再生であって、
  // 記録元の実 API が決定的であったことの証明ではない**——anthropic/openai 側の
  // 同名オプションの doc コメントと同じ非対称。
  deterministic: true,
  prompt: RECORDED_PROMPT,
  structured: {
    prompt: RECORDED_STRUCTURED_PROMPT,
    schema: recordedStructuredSchema,
  },
  // `RecordedLLMProvider` は下層 client を注入する口を持たない——lookup 失敗の理由は
  // 「カセットに記録が無い」であって「下層 SDK の呼び出しが失敗した」ではないため、
  // `createFailing` のハーネスを組みようが無い（`DeterministicLLMProvider` と同じ理由で null）。
  createFailing: null,
});
