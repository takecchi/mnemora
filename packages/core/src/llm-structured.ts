import type { AbortOptions } from "./abort.js";
import type { Ctx } from "./ctx.js";
import type {
  LLMProvider,
  StructuredRequest,
  StructuredResponse,
} from "./interfaces/llm-provider.js";

/**
 * `llmProvider.completeStructuredWithMeta` があればそれを、無ければ `completeStructured` を呼ぶ。
 * 応答のモデル名が空文字のときは、確かめていないものとして省く。
 */
export async function callStructuredWithMeta<T>(
  llmProvider: LLMProvider,
  ctx: Ctx,
  req: StructuredRequest<T>,
  opts?: AbortOptions,
): Promise<StructuredResponse<T>> {
  if (llmProvider.completeStructuredWithMeta === undefined) {
    return { value: await llmProvider.completeStructured(ctx, req, opts) };
  }
  const response = await llmProvider.completeStructuredWithMeta(ctx, req, opts);
  return typeof response.respondedModel === "string" && response.respondedModel.length > 0
    ? { value: response.value, respondedModel: response.respondedModel }
    : { value: response.value };
}
