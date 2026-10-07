import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "@mnemora/core";
import OpenAI from "openai";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

/** ここで注入する `client` は本物の OpenAI SDK ではない。ネットワーク往復（HTTP・認証・リトライ）は検査しない。本物に対する検査は `live.openai.test.ts` に分離する。 */
const ctx: Ctx = { tenantId: "tenant-1" };

describe("OpenAIEmbeddingProvider", () => {
  it("space は provider/model/dimensions で固定される（D8・§5.5）", () => {
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 4,
      client: { embeddings: { create: vi.fn() } } as never,
    });
    expect(provider.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 4,
    });
  });

  it("embed は空配列に対して client を呼ばずに空配列を返す", async () => {
    const create = vi.fn();
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 4,
      client: { embeddings: { create } } as never,
    });
    const result = await provider.embed(ctx, []);
    expect(result).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("embed はレスポンスの index 順に並べ替えてベクトルを返す（順序を暗黙に信頼しない）", async () => {
    const create = vi.fn().mockResolvedValue({
      data: [
        { index: 1, embedding: [0.2, 0.2] },
        { index: 0, embedding: [0.1, 0.1] },
      ],
      model: "text-embedding-3-small",
      object: "list",
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });

    const result = await provider.embed(ctx, ["a", "b"]);
    expect(result).toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    expect(create).toHaveBeenCalledWith(
      {
        model: "text-embedding-3-small",
        input: ["a", "b"],
        dimensions: 2,
      },
      // `embed` は常に第2引数（request options）を渡す。`opts?.signal` を省略した呼び出しでは `{ signal: undefined }` になる。
      { signal: undefined },
    );
  });

  /**
   * `OpenAIEmbeddingProvider` は入力トークン数の上限を自前で検査せず、サーバの拒否に依存している。そのため、client が例外を投げたとき `embed()` がそれを握りつぶさず・切り詰めて再送もせず、そのまま伝播することを固定する。`embed()` には `try/catch` が無く、握りつぶす変更が入ったらこの歯が最初に落ちる。
   * 投げる client は、実際の OpenAI SDK が HTTP 400 で投げる例外（`OpenAI.BadRequestError`）を、実 API から得た文面そのままで組み立てる。`text-embedding-3-small` に `" hello".repeat(10000)` を送ると `Invalid 'input[0]': maximum input length is 8192 tokens.` が返る。
   */
  it("client が HTTP 400（入力トークン数の上限超過）を投げると、embed() はそれを握りつぶさず・切り詰めて再送もせず、そのまま reject する", async () => {
    const serverError = new OpenAI.BadRequestError(
      400,
      {
        message: "Invalid 'input[0]': maximum input length is 8192 tokens.",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
      "400 Bad Request",
      new Headers(),
    );
    const create = vi.fn().mockRejectedValue(serverError);
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client: { embeddings: { create } } as never,
    });

    await expect(provider.embed(ctx, [" hello".repeat(10000)])).rejects.toBe(serverError);
    // 1回しか呼ばない。切り詰めて黙って再送すると、ここが2回以上になる。
    expect(create).toHaveBeenCalledTimes(1);
  });
});
