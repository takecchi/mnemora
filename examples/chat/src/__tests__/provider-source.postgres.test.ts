import { afterAll, describe, expect, it } from "vitest";
import { cassetteExists, cassettePathFor, loadCassette } from "../cassette-io.js";
import { decideProviderSource } from "../providers.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

// 偽の OPENAI_API_KEY は process.env ではなく、createExampleRuntime へ渡す env の中だけに置く。本物のキーは使わない。
describe("provider source の解決が実際の runtime 構築まで届く（ADR 0068 ③-4）", () => {
  it(
    "OPENAI_API_KEY が(偽値で)在っても、MNEMORA_PROVIDER_SOURCE=recorded を明示すれば " +
      "llmMode/embeddingMode が recorded になる（実 API に倒れない）",
    async () => {
      await resetTestDatabase();

      const retrievalCassettePath = cassettePathFor("retrieval");
      if (!cassetteExists(retrievalCassettePath)) {
        throw new Error(
          "examples/chat/cassettes/retrieval.json が無い。この歯は実測のカセットを前提にしている。",
        );
      }
      const cassette = loadCassette(retrievalCassettePath);

      const env = {
        OPENAI_API_KEY: "sk-test-dummy-not-real",
        MNEMORA_PROVIDER_SOURCE: "recorded",
      };
      const decision = decideProviderSource(env);
      expect(decision).toEqual({ source: "recorded", reason: "forced" });

      const handle = await createExampleRuntime(
        requireDatabaseUrl(),
        { ...env, MNEMORA_LLM: decision.source, MNEMORA_EMBEDDING: decision.source },
        { cassette },
      );
      try {
        expect(handle.llmMode).toBe("recorded");
        expect(handle.embeddingMode).toBe("recorded");
        expect(handle.usageMeter).toBeUndefined();
      } finally {
        await handle.close();
      }
    },
  );

  it("MNEMORA_PROVIDER_SOURCE を指定しなければ、キーが在るとき従来通り openai になる（既定は変えていない）", () => {
    const env = { OPENAI_API_KEY: "sk-test-dummy-not-real" };
    expect(decideProviderSource(env)).toEqual({ source: "openai", reason: "key-present" });
  });
});

afterAll(async () => {
  await closeTestClient();
});
