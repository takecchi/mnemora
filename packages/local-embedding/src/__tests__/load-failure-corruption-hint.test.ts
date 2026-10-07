import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";

const ctx: Ctx = { tenantId: "corruption-hint" };

const failing: CreateLocalEmbeddingPipeline = async () => {
  throw new Error("Protobuf parsing failed.");
};

async function loadFailure(attempts: number): Promise<Error> {
  const provider = new LocalEmbeddingProvider({
    cacheDir: "/tmp/mnemora-models",
    createPipeline: failing,
    retry: { attempts, delayMs: () => 0 },
    sleep: async () => {},
  });
  const reason = await provider.embed(ctx, ["テキスト"]).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(reason, "読み込みが失敗したのに reject しなかった").toBeInstanceOf(Error);
  return reason as Error;
}

// 文面の全文一致では固定しない（言い回しを直せなくなる）。見るのは、利用者が壊れたキャッシュだと見分けて直すのに要る語が入っているかだけ。
describe("読み込み失敗のメッセージは、キャッシュの破損を見分けて直すのに要る語を持つ", () => {
  it.each([1, 3])(
    "試行が %i 回でも、原因の列に破損が入り、cause の形（Protobuf・JSON）で見分けられる",
    async (attempts) => {
      const message = (await loadFailure(attempts)).message;
      expect(message).toMatch(/dtype 名の誤り[^。]*破損/);
      expect(message).toContain("Protobuf");
      expect(message).toContain("JSON");
    },
  );
});
