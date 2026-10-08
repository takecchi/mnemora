import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

/** `client` は手書きの偽物で、本物の API を叩かない。ここが測るのは「渡したテキストを provider が黙って変えずに送る」ことだけ。 */
const ctx: Ctx = { tenantId: "tenant-1" };

describe("OpenAIEmbeddingProvider.embed: 入力を変えずに送る", () => {
  it("長いテキストも切り詰めずに、1回の呼び出しの input としてそのまま送る", async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      model: "text-embedding-3-small",
      object: "list",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });
    const longText = "あ".repeat(10000);

    await provider.embed(ctx, [longText]);

    // core の EmbeddingProvider は、黙って切り詰めたベクトルを返してはならないと約束している。
    expect(create).toHaveBeenCalledTimes(1);
    const input: string[] = create.mock.calls[0]![0].input;
    expect(input).toEqual([longText]);
    expect(input[0]).toHaveLength(10000);
  });
});
