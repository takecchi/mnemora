// 公開している包み型の provider（`SeededLLMProvider`/`SeededEmbeddingProvider`、
// `RecordingLLMProvider`/`RecordingEmbeddingProvider`）に、既存の適合テスト一式をそのまま
// 当てる。**一式には要件を1つも足さない。**
//
// それまで一式は、包まれる側（`DeterministicLLMProvider` ほか）にだけ当たっていた。包み型は
// `examples/chat` の `providers.ts` で実 API の provider と重ねて使われる（種の再生・記録）ので、
// 包んだことで契約（空入力・順序・次元・例外を握り潰さない・リトライを内蔵しない等）が
// 崩れていないかを、包み型そのものに対して測る。包まれる側には `Deterministic*` を使う。
//
// `createFailing`: 包み型は下層の SDK client を持たないが、**包まれる側が下層にあたる**
// ——必ず失敗する `LLMProvider` を包ませ、その呼び出し回数を数える。

import { vi } from "vitest";
import { z } from "zod";
import type { LLMProvider } from "@mnemora/core";
import { describeEmbeddingProviderConformance } from "../embedding-provider-conformance.js";
import { describeLLMProviderConformance } from "../llm-provider-conformance.js";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { DeterministicLLMProvider } from "../__fixtures__/deterministic-llm-provider.js";
import { SeededEmbeddingProvider, SeededLLMProvider } from "../__fixtures__/seeded-provider.js";
import {
  CassetteRecorder,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
} from "../__fixtures__/cassette-recorder.js";

const MODEL = "wrapper-conformance-model";

const structuredSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const llmCommon = {
  deterministic: true,
  prompt: { messages: [{ role: "user" as const, content: "決定的な入力" }] },
  structured: {
    prompt: { messages: [{ role: "user" as const, content: "決定的な構造化入力" }] },
    schema: structuredSchema,
  },
};

function failingDelegate(error: unknown) {
  const complete = vi.fn().mockRejectedValue(error);
  const completeStructured = vi.fn().mockRejectedValue(error);
  const delegate: LLMProvider = { complete, completeStructured };
  return {
    delegate,
    callCount: () => complete.mock.calls.length + completeStructured.mock.calls.length,
  };
}

function emptyLLMSeed() {
  return { seed: { model: MODEL, entries: {} }, expectedModel: MODEL };
}

describeLLMProviderConformance({
  name: "SeededLLMProvider（種が空——すべて包まれる側へ委ねる）",
  createProvider: () => new SeededLLMProvider(new DeterministicLLMProvider(), emptyLLMSeed()),
  ...llmCommon,
  createFailing: (error) => {
    const { delegate, callCount } = failingDelegate(error);
    return { provider: new SeededLLMProvider(delegate, emptyLLMSeed()), callCount };
  },
});

describeLLMProviderConformance({
  name: "RecordingLLMProvider",
  createProvider: () =>
    new RecordingLLMProvider(new DeterministicLLMProvider(), new CassetteRecorder(), MODEL),
  ...llmCommon,
  createFailing: (error) => {
    const { delegate, callCount } = failingDelegate(error);
    return {
      provider: new RecordingLLMProvider(delegate, new CassetteRecorder(), MODEL),
      callCount,
    };
  },
});

const embeddingTexts = { a: "赤", b: "青", c: "緑" };

describeEmbeddingProviderConformance({
  name: "SeededEmbeddingProvider（種が空——すべて包まれる側へ委ねる）",
  createProvider: () => {
    const inner = new DeterministicEmbeddingProvider();
    return new SeededEmbeddingProvider(inner, {
      seed: { space: inner.space, entries: {} },
      expectedSpace: inner.space,
    });
  },
  deterministic: true,
  texts: embeddingTexts,
});

describeEmbeddingProviderConformance({
  name: "RecordingEmbeddingProvider",
  createProvider: () =>
    new RecordingEmbeddingProvider(new DeterministicEmbeddingProvider(), new CassetteRecorder()),
  deterministic: true,
  texts: embeddingTexts,
});
