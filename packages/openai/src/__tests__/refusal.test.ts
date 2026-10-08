import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import type { OpenAILLMProviderError } from "../errors.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 拒否（`message.refusal`）を「空の成功」にしない。拒否時は `content` が `null` になるので、`message.refusal` / `finish_reason` を見ないと `no_content` に化ける。
 * OpenAI は Anthropic の `stop_reason` 一本とは形が違い、`message.refusal`（拒否理由の文字列）と `finish_reason`（`"length"` / `"content_filter"` 等）の2つの機構が独立している。両方をそれぞれ見る。
 * この歯が測るのは「赤くなること」ではなく「区別が付くこと」。どちらの入力でも同じように赤くなる歯は区別を測っていないので、必ず対で書く（拒否のとき `kind === "refusal"` かつ `"no_content"` ではない。逆も同じ）。
 * 実 API が本当にこの形を返すところは見ていない。openai SDK 7.10.0 の型定義に対してこちらが正しく反応することを固定する。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const schema = z.object({ content: z.string() });
const structuredRequest = {
  prompt: { messages: [{ role: "user" as const, content: "なにか教えて" }] },
  schema,
};

function buildWithResponse(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const provider = new OpenAILLMProvider({
    model: "gpt-test",
    client: { chat: { completions: { create } } } as never,
  });
  return { provider, create };
}

const refusalResponse = {
  choices: [
    {
      finish_reason: "stop",
      message: { refusal: "I can't help with that request.", content: null },
    },
  ],
};
const emptyResponse = {
  choices: [{ finish_reason: "stop", message: { refusal: null, content: "" } }],
};

async function captureError(run: () => Promise<unknown>): Promise<OpenAILLMProviderError> {
  try {
    await run();
  } catch (error) {
    return error as OpenAILLMProviderError;
  }
  // `expect.fail` を使う（素の `throw new Error` にしない）。変異試験で「AssertionError の件数」を数えるとき、歯が噛んだのか器が転んだのかを区別できる形にするため。
  return expect.fail("例外が投げられなかった（黙って成功した＝歯が意味を失っている）");
}

describe("completeStructured: 拒否と空応答を区別する", () => {
  it("拒否のとき kind は 'refusal' であり、'no_content' ではない", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    // 区別を測る側。ここが無いと「どちらでも赤い」歯になる。
    expect(error.kind).not.toBe("no_content");
  });

  it("空応答のとき kind は 'no_content' であり、'refusal' ではない", async () => {
    const { provider } = buildWithResponse(emptyResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("no_content");
    expect(error.kind).not.toBe("refusal");
  });

  it("拒否と空応答は、別のメッセージになる（kind を見ない呼び出し側にも区別が届く）", async () => {
    const { provider: refusing } = buildWithResponse(refusalResponse);
    const { provider: empty } = buildWithResponse(emptyResponse);

    const refusalError = await captureError(() =>
      refusing.completeStructured(ctx, structuredRequest),
    );
    const emptyError = await captureError(() => empty.completeStructured(ctx, structuredRequest));

    expect(refusalError.message).not.toBe(emptyError.message);
    expect(refusalError.message).toMatch(/refused/);
    // `@mnemora/anthropic` と揃えた既存の契約は壊さない（provider-parity.test.ts が依存している）。
    expect(emptyError.message).toMatch(/structured completion returned no content/);
  });

  it("拒否理由の文面（refusalMessage）を落とさない", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.refusalMessage).toBe("I can't help with that request.");
  });

  it("message.refusal が1文字でも拒否として扱う（拒否なしと読むのは空文字だけ）", async () => {
    const { provider } = buildWithResponse({
      choices: [{ finish_reason: "stop", message: { refusal: "x", content: null } }],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    expect(error.refusalMessage).toBe("x");
  });

  it("message.refusal による拒否でも、生の finish_reason を残す", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    expect(error.finishReason).toBe("stop");
  });

  it("⚠ 拒否の判定は content より先に走る（正常っぽい JSON が在っても拒否は拒否）", async () => {
    // 順序を測る歯。`content` を先に読む実装だと、この応答は「普通の成功」に化ける。
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            refusal: "I can't help with that request.",
            content: JSON.stringify({ content: "answered anyway" }),
          },
        },
      ],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
  });

  it("finish_reason: 'content_filter' も 'refusal' として扱う（情報は潰さない）", async () => {
    const { provider } = buildWithResponse({
      choices: [{ finish_reason: "content_filter", message: { refusal: null, content: null } }],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("refusal");
    // 生の finish_reason が落ちていないこと（コンテンツフィルタと拒否メッセージは別機構）。
    expect(error.finishReason).toBe("content_filter");
  });
});

describe("completeStructured: 切り詰めを『壊れた JSON』と混ぜない", () => {
  it("finish_reason: 'length' で切れたら kind は 'truncated'（SyntaxError にしない）", async () => {
    // 切り詰められた JSON はそのまま `JSON.parse` へ渡すと SyntaxError になり、「モデルが壊れた JSON を吐いた」と区別が付かなくなる。
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "length",
          message: { refusal: null, content: '{"content":"途中で切れ' },
        },
      ],
    });
    const error = await captureError(() => provider.completeStructured(ctx, structuredRequest));

    expect(error.kind).toBe("truncated");
    expect(error.finishReason).toBe("length");
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it("正常な finish_reason: 'stop' は素通りする（門が広すぎないこと）", async () => {
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "stop",
          message: { refusal: null, content: JSON.stringify({ content: "ok" }) },
        },
      ],
    });
    await expect(provider.completeStructured(ctx, structuredRequest)).resolves.toEqual({
      content: "ok",
    });
  });

  it("length 以外の finish_reason（tool_calls）は切り詰めと読まず、素通りする", async () => {
    const { provider } = buildWithResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { refusal: null, content: JSON.stringify({ content: "ok" }) },
        },
      ],
    });
    await expect(provider.completeStructured(ctx, structuredRequest)).resolves.toEqual({
      content: "ok",
    });
  });

  it("finish_reason が無くても素通りする（『分からない』を『拒否された』と読まない）", async () => {
    const { provider } = buildWithResponse({
      choices: [{ message: { refusal: null, content: JSON.stringify({ content: "ok" }) } }],
    });
    await expect(provider.completeStructured(ctx, structuredRequest)).resolves.toEqual({
      content: "ok",
    });
  });
});

describe("complete: 拒否を空文字で握り潰さない", () => {
  const prompt = { messages: [{ role: "user" as const, content: "なにか教えて" }] };

  it("拒否のとき例外を投げる（空文字を成功として返さない）", async () => {
    const { provider } = buildWithResponse(refusalResponse);
    const error = await captureError(() => provider.complete(ctx, prompt));

    expect(error.kind).toBe("refusal");
  });

  it("⚠ 拒否ではない空応答では、いまも空文字を返す（望ましい姿ではない）", async () => {
    // これは「安全である」とは主張しない。「いまはこうだが望ましい姿ではない」を固定する歯で、改善を禁じる意味ではない。直すときは両 provider 同時に、この歯ごと書き換えること。
    const { provider } = buildWithResponse(emptyResponse);
    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "" });
  });
});
