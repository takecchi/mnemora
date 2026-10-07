import type { Ctx } from "@mnemora/core";
import { describeEmbeddingProviderConformance } from "../embedding-provider-conformance.js";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { RecordedEmbeddingProvider } from "../__fixtures__/recorded-embedding-provider.js";
import { CassetteRecorder, RecordingEmbeddingProvider } from "../__fixtures__/cassette-recorder.js";
import type { EmbeddingCassetteSection } from "../__fixtures__/cassette.js";

const ctx: Ctx = { tenantId: "embedding-provider-conformance-fixtures" };

describeEmbeddingProviderConformance({
  name: "DeterministicEmbeddingProvider",
  createProvider: () => new DeterministicEmbeddingProvider(),
  deterministic: true,
  texts: { a: "赤", b: "青", c: "緑" },
});

// `RecordedEmbeddingProvider` は記録に無い入力で投げるので、`texts` はカセットに実在するテキストにする。カセットは `examples/chat/cassettes/*.json` に頼らず、テスト内で最小のものを組み立てる。
let cachedSection: EmbeddingCassetteSection | undefined;

async function buildSection(): Promise<EmbeddingCassetteSection> {
  if (cachedSection) {
    return cachedSection;
  }
  const recorder = new CassetteRecorder();
  const recording = new RecordingEmbeddingProvider(new DeterministicEmbeddingProvider(), recorder);
  await recording.embed(ctx, ["なつめ", "いちじく", "ざくろ"]);
  // `CassetteRecorder.toCassette()` は embedding/llm の両節が1件以上無いと落ちるので、ガードを満たすためだけにダミーの LLM 記録を1件足す。
  recorder.recordLLM(
    "embedding-provider-conformance-fixtures",
    { messages: [{ role: "user", content: "n/a" }] },
    "n/a（この suite は embedding 節しか読まない）",
  );
  cachedSection = recorder.toCassette().embedding;
  return cachedSection;
}

describeEmbeddingProviderConformance({
  name: "RecordedEmbeddingProvider",
  createProvider: async () => new RecordedEmbeddingProvider({ section: await buildSection() }),
  deterministic: true,
  texts: { a: "なつめ", b: "いちじく", c: "ざくろ" },
});
